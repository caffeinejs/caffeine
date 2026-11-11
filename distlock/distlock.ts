import { addAbortListener } from 'node:events'

import type { Logger } from '@caffeinejs/application/logger'
import { type OnDestroy } from '@caffeinejs/di'
import { formatDuration, type Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { acquireChannel, onceChannel, publishContended, traced, withLockChannel, type Writable } from './_channels.js'
import { HeldLock } from './_lock.js'
import { type Backend, type LockLease } from './backend.js'
import { ErrDistLockConfiguration, ErrInvalidLockKey, ErrLockBackendTimeout, ErrLockNotAcquired } from './errors.js'
import type {
  AcquireContext,
  AcquireMode,
  AcquireOutcome,
  OnceContext,
  OnceOutcome,
  WithLockContext,
} from './observability/channels.js'
import { LockEvents } from './observability/events.js'
import { MAX_TIMER_DELAY, type DistLockOptions } from './options.js'
import { boundedCall, type StoreCall } from './store_call.js'

/** A lease this process currently holds. */
export interface Lock {
  readonly key: string
  readonly token: string

  /** Identifies this lease in every event it produces, from acquisition to release. */
  readonly leaseID: number

  /**
   * Epoch milliseconds the lease is good until, as the backend reported it.
   *
   * When extends under the same token overlap, the backend may apply them in a different order from their replies.
   * The lock uses the earliest expiry that those writes could have left in the backend.
   */
  readonly expiresAt: number

  /**
   * Whether the lease is gone — its validity has passed, it was released, or a renewal found it taken.
   *
   * Also `true` while a shortening extension, timeout or refusal leaves ownership uncertain. The backend may
   * have shortened the lease or rotated its token before answering.
   */
  get lost(): boolean

  /**
   * Aborts when the lease is gone: taken by another holder, expired by the clock, lost to a backend failure, or
   * released, as soon as `release()` is called rather than once the backend answers. An extend to a shorter `ttl`
   * that has not answered aborts it once that `ttl` runs out, since the key may be free from then on; nothing
   * answering later revives it. `signal.reason` is an {@link ErrLockLost} or an {@link ErrLockReleased}. A `once`
   * lock whose action returned has left its holder's hands: the window lapsing aborts nothing and publishes no
   * `lost`.
   *
   * Cancellation is cooperative: pass the signal to the I/O the critical section does, such as `fetch` or a
   * database query, so the work stops with the lease.
   */
  readonly signal: AbortSignal

  /**
   * Extends the lease by `ttl`, or by the lock service's default when omitted.
   *
   * `false` means the lease was lost or ownership could not be confirmed when the call completed.
   * An overlapping write can leave ownership uncertain even when the backend applied this extension.
   */
  extend(ttl?: Duration): Promise<boolean>

  /** Releases the key, unless the lease was already lost. Releasing twice is harmless. */
  release(): Promise<void>

  [Symbol.asyncDispose](): Promise<void>
}

/** How a single acquisition behaves. Each member falls back to the value the feature was configured with. */
export interface AcquireOptions {
  /** How long the lease is good for. */
  ttl?: Duration

  /** How long `acquire` keeps retrying before it gives up. `0` makes it a single attempt. */
  wait?: Duration

  /** How long to pause between attempts, before jitter. */
  retryDelay?: Duration

  /** Renews the lease in the background for as long as the lock is held. Off by default. */
  renew?: boolean

  signal?: AbortSignal
}

/** How one {@link DistLock.once} call behaves. */
export interface OnceOptions {
  /**
   * The window the key stays taken for, measured from the moment it was acquired — not from when the action
   * finished, so a job running on a fixed period does not drift.
   */
  ttl?: Duration

  /**
   * Renews the lease while the action runs, so work outliving `ttl` does not reopen the window underneath
   * itself. The window then ends one `ttl` after the last renewal rather than after the acquisition.
   */
  renew?: boolean

  /** Whether a throwing action gives the key back, letting another caller retry inside the window. Defaults to `true`. */
  releaseOnError?: boolean

  signal?: AbortSignal
}

/** What {@link DistLock.once} reports: whether this caller is the one that ran the action. */
export type OnceResult<T> =
  | { readonly executed: true; readonly result: T }
  | { readonly executed: false; readonly result?: undefined }

/**
 * Mutual exclusion across every replica of an application, over whatever backend was installed.
 *
 * Injected with the `kDistLock` key — this is an interface, so it carries no runtime identity of its own.
 */
export interface DistLock {
  /**
   * What this lock service did, as typed events: `lock.events.on('lost', ...)`.
   *
   * Each event is what the matching `node:diagnostics_channel` published, narrowed to this service. A listener
   * that throws or rejects is logged once per event on the lock service's logger and never reaches the lock.
   */
  readonly events: LockEvents

  /**
   * One attempt. `undefined` when the key is held by someone else, or when the lease the backend handed out had
   * already lapsed by the time it arrived.
   *
   * @throws ErrLockBackendTimeout when the backend did not answer within `min(storeTimeout, ttl)`.
   * @throws ErrInvalidLockKey when the key is empty or not a string.
   */
  tryAcquire(key: string, options?: AcquireOptions): Promise<Lock | undefined>

  /**
   * Retries until the key is taken. One attempt can outlast `wait` by up to `min(storeTimeout, ttl)`. A backend
   * that did not answer in time is retried while `wait` remains; any other backend error rejects at once.
   *
   * @throws ErrLockNotAcquired when the `wait` budget runs out on contention, ErrLockBackendTimeout when it runs
   * out with the last attempt unanswered, and whatever `signal` aborted with when it aborts.
   * @throws ErrInvalidLockKey when the key is empty or not a string.
   */
  acquire(key: string, options?: AcquireOptions): Promise<Lock>

  /**
   * Acquires the key, runs the action, and releases in a `finally` — on success and on throw alike.
   *
   * A release that fails after the action returned is logged, not thrown: the result stands and the lease lapses
   * at `expiresAt`.
   */
  withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options?: AcquireOptions): Promise<T>

  /**
   * Runs the action at most once per window across every replica, and returns immediately when somebody else
   * already has it.
   *
   * The key is **not** released when the action succeeds: what is left of the lease is the window, which is
   * what keeps a later caller out as well as a concurrent one.
   */
  once<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options?: OnceOptions): Promise<OnceResult<T>>
}

/**
 * The lock service the `distlock` feature publishes under the `kDistLock` key.
 *
 * Construct one directly to use the package without an application. Its options are the defaults a call falls
 * back to when it carries none of its own. Pass `newNoopLogger()` from `@caffeinejs/application/logger` as `log`
 * to keep it silent.
 *
 * Waiting, retrying, backoff and jitter all happen here rather than in the backend, which only ever makes one
 * attempt.
 *
 * @throws ErrDistLockConfiguration when `options.storeTimeout` is not above zero or is longer than a timer can
 * wait.
 */
export class CaffeineDistLock implements DistLock, OnDestroy {
  readonly backend: Backend
  readonly options: DistLockOptions
  readonly log: Logger

  readonly #renewing = new Set<HeldLock>()
  #events: LockEvents | undefined
  #disposed = false

  constructor(backend: Backend, options: DistLockOptions, log: Logger) {
    if (!(options.storeTimeout > 0 && options.storeTimeout <= MAX_TIMER_DELAY)) {
      throw new ErrDistLockConfiguration(
        errMessage(
          `Cannot construct the lock service: store timeout "${formatDuration(options.storeTimeout)}" is not above zero and at most ${formatDuration(MAX_TIMER_DELAY)}`,
        )
          .solutions(
            `Pass a storeTimeout above zero and at most ${formatDuration(MAX_TIMER_DELAY)}, such as 5 * Second`,
          )
          .reference('@caffeinejs/distlock', ErrDistLockConfiguration)
          .build(),
      )
    }

    this.backend = backend
    this.options = options
    this.log = log
  }

  get events(): LockEvents {
    this.#events ??= new LockEvents(this, this.log)
    return this.#events
  }

  /**
   * Stops every renewal timer when the container is disposed, and waits for the renewals already in flight.
   *
   * Disposal stops automatic renewal, acquisition retries and late hand-backs. An outstanding renewal is
   * waited for up to its store deadline. A command already sent can still complete unless the backend can
   * cancel or drain it. The listeners on {@link events} are removed after the bounded renewal waits.
   *
   * Callers finish work already using the service before tearing down its backend. `withLock` releases on
   * its own path, and a completed `once` window is left to expire.
   */
  async onDestroy(): Promise<void> {
    this.#disposed = true
    const locks = [...this.#renewing]
    this.#renewing.clear()

    for (const lock of locks) {
      lock.stopRenewal()
    }

    await Promise.all(locks.map(lock => lock.settled()))

    this.#events?.removeAllListeners()
  }

  /**
   * Releases a lease the backend handed over after its caller stopped waiting, or after its holder let go, so the
   * key does not stay taken for a whole lease with nobody holding it. The backend compares tokens, so this never
   * frees a key another holder has since taken.
   *
   * Once the service is disposed this sends nothing: the backend may already be torn down, and the lease lapses
   * at its ttl.
   */
  giveBack(lease: LockLease): void {
    if (this.#disposed) {
      this.log.debug({ key: lease.key }, 'lock lease not given back after shutdown')
      return
    }

    const call: StoreCall = {
      operation: 'release',
      key: lease.key,
      timeout: this.options.storeTimeout,
      bound: 'storeTimeout',
    }

    boundedCall(call, signal => this.backend.release(lease, signal)).then(
      () => this.log.debug({ key: lease.key }, 'lock lease given back'),
      // Whatever made the lease late or unwanted was already warned about; the lease lapses at its ttl.
      (error: unknown) => this.log.debug({ err: error, key: lease.key }, 'lock lease give-back failed'),
    )
  }

  async tryAcquire(key: string, options: AcquireOptions = {}): Promise<Lock | undefined> {
    checkKey(key)
    const ttl = options.ttl ?? this.options.ttl

    return traced(
      acquireChannel,
      () => this.#acquireContext(key, 'try', ttl, 0),
      ctx => this.#tryAcquire(key, ttl, options.renew === true, options.signal, ctx),
    )
  }

  async acquire(key: string, options: AcquireOptions = {}): Promise<Lock> {
    checkKey(key)
    return this.#acquireTraced(key, options)
  }

  async withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    checkKey(key)
    return traced(
      withLockChannel,
      (): Writable<WithLockContext> => ({ service: this, key }),
      ctx => this.#withLock(key, fn, options, ctx),
    )
  }

  async once<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: OnceOptions = {}): Promise<OnceResult<T>> {
    checkKey(key)
    const ttl = options.ttl ?? this.options.ttl

    return traced(
      onceChannel,
      (): Writable<OnceContext> => ({ service: this, key, ttl }),
      ctx => this.#once(key, fn, ttl, options, ctx),
    )
  }

  #acquireTraced(key: string, options: AcquireOptions, parent?: WithLockContext): Promise<HeldLock> {
    const ttl = options.ttl ?? this.options.ttl
    const wait = options.wait ?? this.options.wait

    return traced(
      acquireChannel,
      () => this.#acquireContext(key, 'wait', ttl, wait, parent),
      ctx => this.#acquire(key, ttl, wait, options, ctx),
    )
  }

  async #tryAcquire(
    key: string,
    ttl: Duration,
    renew: boolean,
    signal: AbortSignal | undefined,
    ctx: Writable<AcquireContext> | undefined,
    window = false,
  ): Promise<HeldLock | undefined> {
    const started = Date.now()
    const tally = newTally()
    tally.attempts = 1

    let lease: LockLease | Miss
    try {
      lease = await this.#attempt(key, ttl, signal, tally)
    } catch (error) {
      this.#settleAcquire(ctx, key, tally.aborted ? 'aborted' : 'error', tally, started)
      throw error
    }

    if (typeof lease === 'string') {
      this.#settleAcquire(ctx, key, lease, tally, started)
      return undefined
    }

    const lock = this.#hold(lease, ttl, renew, window)
    this.#settleAcquire(ctx, key, 'acquired', tally, started, lock)

    return lock
  }

  async #acquire(
    key: string,
    ttl: Duration,
    wait: Duration,
    options: AcquireOptions,
    ctx: Writable<AcquireContext> | undefined,
  ): Promise<HeldLock> {
    const retryDelay = options.retryDelay ?? this.options.retryDelay
    const started = Date.now()
    const deadline = started + wait
    const tally = newTally()

    let lease: LockLease | undefined
    try {
      lease = await this.#retry(key, ttl, deadline, retryDelay, options.signal, tally)
    } catch (error) {
      this.#settleAcquire(ctx, key, tally.aborted ? 'aborted' : 'error', tally, started)
      throw error
    }

    if (lease === undefined) {
      this.#settleAcquire(ctx, key, 'timeout', tally, started)
      throw new ErrLockNotAcquired(key, wait)
    }

    const lock = this.#hold(lease, ttl, options.renew === true)
    this.#settleAcquire(ctx, key, 'acquired', tally, started, lock)

    return lock
  }

  // A lease that arrives once the service is closing starts no renewal: shutdown already stopped the others, and
  // nothing may write to the backend after it.
  #hold(lease: LockLease, ttl: Duration, renew: boolean, window = false): HeldLock {
    return new HeldLock(this, lease, ttl, renew && !this.#disposed ? this.#renewing : undefined, window)
  }

  // Attempts until the key is taken or the deadline passes, which is `undefined`. Counts into `tally` so a
  // caller that sees it throw still knows how many attempts were made. An attempt the backend did not answer in
  // time is retried like a contended one; when the deadline passes on one, its timeout is what the caller gets.
  // Closing the service ends the retries as the deadline does: the backend may already be torn down.
  async #retry(
    key: string,
    ttl: Duration,
    deadline: number,
    retryDelay: Duration,
    signal: AbortSignal | undefined,
    tally: Tally,
  ): Promise<LockLease | undefined> {
    let timedOut: ErrLockBackendTimeout | undefined
    for (;;) {
      if (signal?.aborted === true) {
        tally.aborted = true
        throw signal.reason
      }

      tally.attempts += 1
      timedOut = undefined
      try {
        const lease = await this.#attempt(key, ttl, signal, tally)
        if (typeof lease !== 'string') {
          return lease
        }
      } catch (error) {
        if (!(error instanceof ErrLockBackendTimeout) || Boolean(signal?.aborted)) {
          throw error
        }

        timedOut = error
      }

      const now = Date.now()
      if (now >= deadline) {
        break
      }

      try {
        await sleep(Math.min(jittered(retryDelay, this.options.retryJitter), deadline - now), signal)
      } catch (error) {
        tally.aborted = true
        throw error
      }
      if (this.#disposed || Date.now() >= deadline) {
        break
      }
    }

    if (timedOut !== undefined) {
      throw timedOut
    }

    return undefined
  }

  // The one place the backend is asked for a key. Waits at most `min(storeTimeout, ttl)`: an answer arriving
  // after `ttl` could only carry a lease already gone. A lease that arrives after the caller stopped waiting, or
  // already lapsed, is given back and never reaches the caller.
  async #attempt(key: string, ttl: Duration, signal: AbortSignal | undefined, tally: Tally): Promise<LockLease | Miss> {
    const { storeTimeout } = this.options
    const attempt = tally.attempts

    let lease: LockLease | undefined
    try {
      lease = await boundedCall(
        {
          operation: 'acquire',
          key,
          timeout: Math.min(storeTimeout, ttl),
          bound: storeTimeout <= ttl ? 'storeTimeout' : 'ttl',
          signal,
          onCallerAbort: () => {
            tally.aborted = true
          },
        },
        bounded => this.backend.tryAcquire(key, ttl, bounded),
        late => {
          if (late !== undefined) {
            this.giveBack(late)
          }
        },
        (error: unknown) => this.log.debug({ err: error, key, operation: 'acquire' }, 'lock backend failed late'),
      )
    } catch (error) {
      // A backend that gave up because the caller aborted did nothing wrong. One incident per call: the attempts
      // after the first that failed are its consequences.
      if (!tally.aborted) {
        const fields = { err: error, key, operation: 'acquire' }
        if (tally.failed) {
          this.log.debug(fields, 'lock backend failed')
        } else {
          this.log.warn(fields, 'lock backend failed')
        }
        tally.failed = true

        if (error instanceof ErrLockBackendTimeout) {
          tally.failures.timeout += 1
        } else {
          tally.failures.other += 1
        }
      }

      throw error
    }

    if (lease === undefined) {
      this.log.trace({ key, attempt }, 'lock contended')
      publishContended(() => ({ service: this, key, attempt }))
      return 'held'
    }

    if (lease.expiresAt <= Date.now()) {
      const fields = { key, ttlMs: ttl, expiresAt: lease.expiresAt }
      if (tally.expired) {
        this.log.debug(fields, 'lock lease expired in transit')
      } else {
        this.log.warn(fields, 'lock lease expired in transit')
      }
      tally.expired = true
      this.giveBack(lease)
      return 'expired'
    }

    return lease
  }

  async #withLock<T>(
    key: string,
    fn: (lock: Lock) => T | Promise<T>,
    options: AcquireOptions,
    ctx: Writable<WithLockContext> | undefined,
  ): Promise<T> {
    const lock = await this.#acquireTraced(key, options, ctx)
    lock.within = ctx
    if (ctx !== undefined) {
      ctx.leaseID = lock.leaseID
    }

    let result: T

    try {
      result = await fn(lock)
    } catch (error) {
      settleHold(ctx, lock)
      // The action's failure is what the caller asked about, so a release that also fails stays quiet here.
      await lock.release().catch(() => undefined)
      throw error
    }

    settleHold(ctx, lock)
    // The action's result is what the caller asked for. A release that fails was logged as a backend failure, and
    // the lease it could not hand back lapses at `expiresAt`.
    await lock.release().catch(() => undefined)

    return result
  }

  async #once<T>(
    key: string,
    fn: (lock: Lock) => T | Promise<T>,
    ttl: Duration,
    options: OnceOptions,
    ctx: Writable<OnceContext> | undefined,
  ): Promise<OnceResult<T>> {
    let lock: HeldLock | undefined
    try {
      lock = await traced(
        acquireChannel,
        () => this.#acquireContext(key, 'once', ttl, 0, ctx),
        actx => this.#tryAcquire(key, ttl, options.renew === true, options.signal, actx, true),
      )
    } catch (error) {
      this.#settleOnce(ctx, key, 'failed')
      throw error
    }

    if (lock === undefined) {
      this.#settleOnce(ctx, key, 'skipped')
      return { executed: false }
    }

    let result: T
    try {
      result = await fn(lock)
    } catch (error) {
      const lapsed = lock.lost
      const keep = options.releaseOnError === false
      // A release reports a lapse of its own; only a key left standing needs this call to say so.
      const warn = keep && lock.claimLapseWarning()

      if (keep) {
        lock.detach()
      } else {
        await lock.release().catch(() => undefined)
      }

      this.#settleOnce(ctx, key, 'failed', lock, lapsed, warn)
      throw error
    }

    const lapsed = lock.lost
    const warn = lock.claimLapseWarning()

    // Deliberately not released: what is left of the lease is the window, and it is what keeps the next
    // caller out as much as the concurrent one. It has left the holder's hands, so its lapsing aborts nothing.
    lock.detach()
    this.#settleOnce(ctx, key, 'executed', lock, lapsed, warn)

    return { executed: true, result }
  }

  #acquireContext(
    key: string,
    mode: AcquireMode,
    ttl: Duration,
    wait: Duration,
    parent?: WithLockContext | OnceContext,
  ): Writable<AcquireContext> {
    return { service: this, key, mode, ttl, wait, parent }
  }

  #settleAcquire(
    ctx: Writable<AcquireContext> | undefined,
    key: string,
    outcome: AcquireOutcome,
    tally: Tally,
    started: number,
    lock?: HeldLock,
  ): void {
    const waited = Date.now() - started
    const { attempts } = tally

    if (ctx !== undefined) {
      ctx.outcome = outcome
      ctx.attempts = attempts
      ctx.failures = { ...tally.failures }
      ctx.waited = waited

      if (lock !== undefined) {
        ctx.leaseID = lock.leaseID
        ctx.expiresAt = lock.expiresAt
      }
    }

    switch (outcome) {
      case 'acquired':
        this.log.debug({ key, leaseID: lock?.leaseID, attempts, waitedMs: waited }, 'lock acquired')
        return
      case 'timeout':
        this.log.warn({ key, attempts, waitedMs: waited }, 'lock acquisition timed out')
        return
      default:
        // `held` and `aborted` are ordinary answers; an `error` was already logged as a backend failure.
        this.log.debug({ key, outcome, attempts, waitedMs: waited }, 'lock not acquired')
    }
  }

  #settleOnce(
    ctx: Writable<OnceContext> | undefined,
    key: string,
    outcome: OnceOutcome,
    lock?: HeldLock,
    lapsed = false,
    warn = false,
  ): void {
    if (ctx !== undefined) {
      ctx.outcome = outcome
      ctx.leaseID = lock?.leaseID
      ctx.lapsed = lapsed
    }

    const fields = { key, leaseID: lock?.leaseID, outcome, lapsed }
    if (warn) {
      this.log.warn(fields, 'lock once outlived its lease')
    } else {
      this.log.debug(fields, 'lock once settled')
    }
  }
}

// An attempt that did not take the key: found held, or handed a lease that had already lapsed.
type Miss = 'held' | 'expired'

// What one `acquire` call has done so far: its attempts, the ones the backend failed by kind, and whether a backend
// failure or a lease that arrived expired was already warned about.
interface Tally {
  attempts: number
  failures: { timeout: number; other: number }
  aborted: boolean
  failed: boolean
  expired: boolean
}

function newTally(): Tally {
  return { attempts: 0, failures: { timeout: 0, other: 0 }, aborted: false, failed: false, expired: false }
}

function checkKey(key: unknown): void {
  if (typeof key !== 'string' || key === '') {
    throw new ErrInvalidLockKey(key)
  }
}

function settleHold(ctx: Writable<WithLockContext> | undefined, lock: HeldLock): void {
  if (ctx !== undefined) {
    ctx.held = Date.now() - lock.acquiredAt
    ctx.lapsed = lock.lost
  }
}

function jittered(delayMs: number, jitter: number): number {
  return jitter <= 0 ? delayMs : delayMs + Math.random() * delayMs * jitter
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }

    const timer = setTimeout(() => {
      callerAbort?.[Symbol.dispose]()
      resolve()
    }, ms)
    timer.unref?.()

    const callerAbort =
      signal === undefined
        ? undefined
        : addAbortListener(signal, () => {
            clearTimeout(timer)
            reject(signal.reason)
          })
  })
}
