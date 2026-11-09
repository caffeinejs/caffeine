import type { Logger } from '@caffeinejs/application/logger'
import { type OnDestroy } from '@caffeinejs/di'
import { exponential, type Backoff } from '@caffeinejs/resilience'
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

  /** Epoch milliseconds the lease is good until, as the backend reported it. */
  readonly expiresAt: number

  /**
   * Whether the lease is gone — its validity has passed, it was released, or a renewal found it taken.
   *
   * Also `true` while an `extend` that timed out has not answered: the backend may have applied it, and a shorter
   * `ttl` shortens the lease, so the lease is not one to act on until the answer says how long it now runs.
   */
  get lost(): boolean

  /**
   * Aborts when the lease is gone: taken by another holder, expired by the clock, lost to a backend failure, or
   * released. `signal.reason` is an {@link ErrLockLost} or an {@link ErrLockReleased}. A `once` lock whose action returned has
   * left its holder's hands: the window lapsing aborts nothing and publishes no `lost`.
   *
   * Cancellation is cooperative: pass the signal to the I/O the critical section does, such as `fetch` or a
   * database query, so the work stops with the lease.
   */
  readonly signal: AbortSignal

  /**
   * Extends the lease by `ttl`, or by the lock service's default when omitted.
   *
   * `false` means the lease was already lost, so whatever the critical section is doing is no longer
   * protected.
   */
  extend(ttl?: Duration): Promise<boolean>

  /** Releases the key, unless the lease was already lost. Releasing twice is harmless. */
  release(): Promise<void>

  [Symbol.asyncDispose](): Promise<void>
}

/**
 * How a single acquisition behaves. Each member but `renew` falls back to the value the feature was configured
 * with; `renew` depends on the method.
 */
export interface AcquireOptions {
  /** How long the lease is good for. */
  ttl?: Duration

  /** How long `acquire` keeps retrying before it gives up. `0` makes it a single attempt. */
  wait?: Duration

  /**
   * The pause after the first attempt, before jitter. Each later pause doubles it, up to `maxRetryDelay`, which
   * also caps this one.
   */
  retryDelay?: Duration

  /** The longest pause between two attempts, before jitter. */
  maxRetryDelay?: Duration

  /**
   * The pause after each attempt, by attempt number from 1. Replaces `retryDelay`, `maxRetryDelay`, the service's
   * `retryJitter` and the service's `backoff` for this call.
   */
  backoff?: Backoff

  /**
   * Renews the lease in the background while the lock is held. On by default in `withLock` and `tryWithLock`,
   * whose scope ends it; off by default for `acquire` and `tryAcquire`, where a forgotten lease would renew for as
   * long as the process lives.
   *
   * A renewing action that never settles holds the key while the process lives: bound its own I/O.
   */
  renew?: boolean

  signal?: AbortSignal
}

/** How one {@link DistLock.tryWithLock} call behaves: one attempt, so nothing about waiting applies. */
export type TryWithLockOptions = Omit<AcquireOptions, 'wait' | 'retryDelay' | 'maxRetryDelay' | 'backoff'>

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

/** What {@link DistLock.tryWithLock} and {@link DistLock.once} report: whether this caller ran the action. */
export type RunResult<T> =
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
   * Retries with exponential backoff until the key is taken. One attempt can outlast `wait` by up to
   * `min(storeTimeout, ttl)`. A backend that did not answer in time is retried while `wait` remains; any other
   * backend error rejects at once.
   *
   * @throws ErrLockNotAcquired when the `wait` budget runs out on contention, ErrLockBackendTimeout when it runs
   * out with the last attempt unanswered, and whatever `signal` aborted with when it aborts.
   * @throws ErrInvalidLockKey when the key is empty or not a string.
   * @throws ErrDistLockConfiguration when a retry option is out of range, before any attempt.
   */
  acquire(key: string, options?: AcquireOptions): Promise<Lock>

  /**
   * Acquires the key, runs the action, and releases in a `finally` — on success and on throw alike. The lease is
   * renewed while the action runs, unless `renew` is `false`.
   *
   * A release that fails after the action returned is logged, not thrown: the result stands and the lease lapses
   * at `expiresAt`.
   *
   * @throws ErrDistLockConfiguration when a retry option is out of range, before any attempt.
   */
  withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options?: AcquireOptions): Promise<T>

  /**
   * Runs the action under the key when it is free, and reports `executed: false` without waiting when another
   * holder has it. Renews and releases like {@link withLock}.
   *
   * @throws ErrLockBackendTimeout when the backend did not answer within `min(storeTimeout, ttl)`.
   * @throws ErrInvalidLockKey when the key is empty or not a string.
   */
  tryWithLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options?: TryWithLockOptions): Promise<RunResult<T>>

  /**
   * Runs the action at most once per window across every replica, and returns immediately when somebody else
   * already has it.
   *
   * The key is **not** released when the action succeeds: what is left of the lease is the window, which is
   * what keeps a later caller out as well as a concurrent one.
   */
  once<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options?: OnceOptions): Promise<RunResult<T>>
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
   * Once this resolves nothing here writes to the backend again, which is what makes disposal a point an
   * adapter can be torn down after. A renewal stuck past `storeTimeout` is not waited for, and an answer it
   * sends later is dropped rather than given back. A command the backend already sent may still complete there
   * unless the backend can cancel or drain it. The listeners on {@link events} are removed last, so they still
   * hear about those renewals.
   *
   * Held keys are left alone: `withLock` releases on its own path, and a `once` window has to outlive the
   * process that opened it or the next replica up would redo the work.
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
    return this.#acquireTraced(key, options, this.#backoff(key, options))
  }

  async withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    checkKey(key)
    const backoff = this.#backoff(key, options)
    const run = await traced(
      withLockChannel,
      (): Writable<WithLockContext> => ({ service: this, key }),
      ctx => this.#withLock(key, fn, options, backoff, ctx),
    )

    // Waiting never skips: the acquisition throws when it gives up.
    return run.result as T
  }

  async tryWithLock<T>(
    key: string,
    fn: (lock: Lock) => T | Promise<T>,
    options: TryWithLockOptions = {},
  ): Promise<RunResult<T>> {
    checkKey(key)
    return traced(
      withLockChannel,
      (): Writable<WithLockContext> => ({ service: this, key }),
      ctx => this.#withLock(key, fn, options, undefined, ctx),
    )
  }

  async once<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: OnceOptions = {}): Promise<RunResult<T>> {
    checkKey(key)
    const ttl = options.ttl ?? this.options.ttl

    return traced(
      onceChannel,
      (): Writable<OnceContext> => ({ service: this, key, ttl }),
      ctx => this.#once(key, fn, ttl, options, ctx),
    )
  }

  #acquireTraced(key: string, options: AcquireOptions, backoff: Backoff, parent?: WithLockContext): Promise<HeldLock> {
    const ttl = options.ttl ?? this.options.ttl
    const wait = options.wait ?? this.options.wait

    return traced(
      acquireChannel,
      () => this.#acquireContext(key, 'wait', ttl, wait, parent),
      ctx => this.#acquire(key, ttl, wait, backoff, options, ctx),
    )
  }

  // A call's own `backoff` wins. A call that names `retryDelay` or `maxRetryDelay` gets the exponential schedule
  // with those, and only a call that names none of them gets the service's `backoff`. Built once per call, before
  // anything is traced, so a bad value is the caller's error and not an acquisition that failed.
  #backoff(key: string, options: AcquireOptions): Backoff {
    if (options.backoff !== undefined) {
      return options.backoff
    }

    if (options.retryDelay === undefined && options.maxRetryDelay === undefined && this.options.backoff !== undefined) {
      return this.options.backoff
    }

    const initialDelay = options.retryDelay ?? this.options.retryDelay
    const maxDelay = options.maxRetryDelay ?? this.options.maxRetryDelay
    const jitter = this.options.retryJitter
    if (!(Number.isFinite(initialDelay) && initialDelay >= 0)) {
      throw invalidRetry(key, `retryDelay "${formatDuration(initialDelay)}" is not a finite Duration of at least 0`)
    }
    if (!(maxDelay >= 0)) {
      throw invalidRetry(key, `maxRetryDelay "${formatDuration(maxDelay)}" is not a Duration of at least 0`)
    }
    // Only a service constructed by hand can get here with it: the builder refuses it.
    if (!(jitter >= 0 && jitter < 1)) {
      throw invalidRetry(key, `retryJitter "${jitter}" is not at least 0 and below 1`)
    }

    return exponential({ initialDelay, multiplier: 2, maxDelay, jitter })
  }

  async #tryAcquire(
    key: string,
    ttl: Duration,
    renew: boolean,
    signal: AbortSignal | undefined,
    ctx: Writable<AcquireContext> | undefined,
  ): Promise<HeldLock | undefined> {
    const started = Date.now()
    const tally = newTally()
    tally.attempts = 1

    let lease: LockLease | Miss
    try {
      lease = await this.#attempt(key, ttl, signal, tally)
    } catch (error) {
      this.#settleAcquire(ctx, key, signal?.aborted === true ? 'aborted' : 'error', tally, started)
      throw error
    }

    if (typeof lease === 'string') {
      this.#settleAcquire(ctx, key, lease, tally, started)
      return undefined
    }

    const lock = new HeldLock(this, lease, ttl, renew ? this.#renewing : undefined)
    this.#settleAcquire(ctx, key, 'acquired', tally, started, lock)

    return lock
  }

  async #acquire(
    key: string,
    ttl: Duration,
    wait: Duration,
    backoff: Backoff,
    options: AcquireOptions,
    ctx: Writable<AcquireContext> | undefined,
  ): Promise<HeldLock> {
    const started = Date.now()
    const deadline = started + wait
    const tally = newTally()

    let lease: LockLease | undefined
    try {
      lease = await this.#retry(key, ttl, deadline, backoff, options.signal, tally)
    } catch (error) {
      this.#settleAcquire(ctx, key, options.signal?.aborted === true ? 'aborted' : 'error', tally, started)
      throw error
    }

    if (lease === undefined) {
      this.#settleAcquire(ctx, key, 'timeout', tally, started)
      throw new ErrLockNotAcquired(key, wait)
    }

    const lock = new HeldLock(this, lease, ttl, options.renew === true ? this.#renewing : undefined)
    this.#settleAcquire(ctx, key, 'acquired', tally, started, lock)

    return lock
  }

  // Attempts until the key is taken or the deadline passes, which is `undefined`. Counts into `tally` so a
  // caller that sees it throw still knows how many attempts were made. An attempt the backend did not answer in
  // time is retried like a contended one; when the deadline passes on one, its timeout is what the caller gets.
  async #retry(
    key: string,
    ttl: Duration,
    deadline: number,
    backoff: Backoff,
    signal: AbortSignal | undefined,
    tally: Tally,
  ): Promise<LockLease | undefined> {
    for (;;) {
      signal?.throwIfAborted()

      tally.attempts += 1
      let timedOut: ErrLockBackendTimeout | undefined
      try {
        const lease = await this.#attempt(key, ttl, signal, tally)
        if (typeof lease !== 'string') {
          return lease
        }
      } catch (error) {
        if (!(error instanceof ErrLockBackendTimeout) || signal?.aborted === true) {
          throw error
        }

        timedOut = error
      }

      const now = Date.now()
      if (now >= deadline) {
        if (timedOut !== undefined) {
          throw timedOut
        }

        return undefined
      }

      await sleep(Math.min(backoff(tally.attempts), deadline - now), signal)
    }
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
      if (signal?.aborted !== true) {
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

  // The one body of `withLock` and `tryWithLock`: `backoff` is how the former waits, and its absence makes the one
  // attempt of the latter. Either renews by default, since the scope of the action ends the lease.
  async #withLock<T>(
    key: string,
    fn: (lock: Lock) => T | Promise<T>,
    options: AcquireOptions,
    backoff: Backoff | undefined,
    ctx: Writable<WithLockContext> | undefined,
  ): Promise<RunResult<T>> {
    const renewing = { ...options, renew: options.renew ?? true }
    const lock =
      backoff === undefined
        ? await this.#tryAcquireTraced(key, renewing, ctx)
        : await this.#acquireTraced(key, renewing, backoff, ctx)

    if (lock === undefined) {
      if (ctx !== undefined) {
        ctx.outcome = 'skipped'
      }
      return { executed: false }
    }

    lock.within = ctx
    if (ctx !== undefined) {
      ctx.leaseID = lock.leaseID
      ctx.outcome = 'executed'
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

    return { executed: true, result }
  }

  #tryAcquireTraced(key: string, options: AcquireOptions, parent: WithLockContext | undefined) {
    const ttl = options.ttl ?? this.options.ttl

    return traced(
      acquireChannel,
      () => this.#acquireContext(key, 'try', ttl, 0, parent),
      ctx => this.#tryAcquire(key, ttl, options.renew === true, options.signal, ctx),
    )
  }

  async #once<T>(
    key: string,
    fn: (lock: Lock) => T | Promise<T>,
    ttl: Duration,
    options: OnceOptions,
    ctx: Writable<OnceContext> | undefined,
  ): Promise<RunResult<T>> {
    let lock: HeldLock | undefined
    try {
      lock = await traced(
        acquireChannel,
        () => this.#acquireContext(key, 'once', ttl, 0, ctx),
        actx => this.#tryAcquire(key, ttl, options.renew === true, options.signal, actx),
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
  failed: boolean
  expired: boolean
}

function invalidRetry(key: string, reason: string): ErrDistLockConfiguration {
  return new ErrDistLockConfiguration(
    errMessage(`Cannot acquire "${key}": ${reason}`)
      .solutions('Pass retry options in range, such as { retryDelay: 50 * Millisecond, maxRetryDelay: 1 * Second }')
      .reference('@caffeinejs/distlock', ErrDistLockConfiguration)
      .build(),
  )
}

function newTally(): Tally {
  return { attempts: 0, failures: { timeout: 0, other: 0 }, failed: false, expired: false }
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }

    let onAbort: (() => void) | undefined

    const timer = setTimeout(() => {
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort)
      }

      resolve()
    }, ms)
    timer.unref?.()

    if (signal !== undefined) {
      onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }

      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
