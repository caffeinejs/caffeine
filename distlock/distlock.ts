import { type OnDestroy } from '@caffeinejs/di'
import { toMillis, type Duration } from '@caffeinejs/std/duration'
import type { Logger } from '@caffeinejs/std/logger'

import { acquireChannel, onceChannel, publishContended, traced, withLockChannel, type Writable } from './_channels.js'
import { HeldLock, type LockHost } from './_lock.js'
import { type Backend, type LockLease } from './backend.js'
import { ErrLockNotAcquired } from './errors.js'
import type {
  AcquireContext,
  AcquireMode,
  AcquireOutcome,
  OnceContext,
  OnceOutcome,
  WithLockContext,
} from './observability/channels.js'
import { LockEvents } from './observability/events.js'
import { type DistLockOptions } from './options.js'

/** A lease this process currently holds. */
export interface Lock {
  readonly key: string
  readonly token: string

  /** Identifies this lease in every event it produces, from acquisition to release. */
  readonly leaseID: number

  /** Epoch milliseconds the lease is good until, as the backend reported it. */
  readonly expiresAt: number

  /** Whether the lease is gone — its validity has passed, it was released, or a renewal found it taken. */
  get lost(): boolean

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

  /** One attempt. `undefined` when the key is held by someone else. */
  tryAcquire(key: string, options?: AcquireOptions): Promise<Lock | undefined>

  /**
   * Retries until the key is taken.
   *
   * @throws ErrLockNotAcquired when the `wait` budget runs out, and whatever `signal` aborted with when it aborts.
   */
  acquire(key: string, options?: AcquireOptions): Promise<Lock>

  /** Acquires the key, runs the action, and releases in a `finally` — on success and on throw alike. */
  withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options?: AcquireOptions): Promise<T>

  /**
   * Runs the action at most once per window across every replica, and returns immediately when somebody else
   * already has it.
   *
   * The key is **not** released when the action succeeds: what is left of the lease is the window, which is
   * what keeps a later caller out as well as a concurrent one.
   */
  once<T>(key: string, fn: () => T | Promise<T>, options?: OnceOptions): Promise<OnceResult<T>>
}

/**
 * The lock service the `distlock` feature publishes under the `kDistLock` key.
 *
 * Construct one directly to use the package without an application. Its options are the defaults a call falls
 * back to when it carries none of its own, already resolved and in milliseconds — a builder normalizes the
 * `'30s'` spellings before it binds, so nothing here parses a duration. Pass `newNoopLogger()` from
 * `@caffeinejs/std/logger` as `log` to keep it silent.
 *
 * Waiting, retrying, backoff and jitter all happen here rather than in the backend, which only ever makes one
 * attempt.
 */
export class CaffeineDistLock implements DistLock, LockHost, OnDestroy {
  readonly backend: Backend
  readonly options: DistLockOptions
  readonly log: Logger

  readonly #renewing = new Set<HeldLock>()
  #events: LockEvents | undefined

  constructor(backend: Backend, options: DistLockOptions, log: Logger) {
    this.backend = backend
    this.options = options
    this.log = log
  }

  get events(): LockEvents {
    this.#events ??= new LockEvents(this, this.log)
    return this.#events
  }

  track(lock: HeldLock): void {
    this.#renewing.add(lock)
  }

  untrack(lock: HeldLock): void {
    this.#renewing.delete(lock)
  }

  /**
   * Stops every renewal timer when the container is disposed, and waits for the renewals already in flight.
   *
   * Once this resolves nothing here writes to the backend again, which is what makes disposal a point an
   * adapter can be torn down after. The listeners on {@link events} are removed last, so they still hear
   * about those renewals.
   *
   * Held keys are left alone: `withLock` releases on its own path, and a `once` window has to outlive the
   * process that opened it or the next replica up would redo the work.
   */
  async onDestroy(): Promise<void> {
    const locks = [...this.#renewing]
    this.#renewing.clear()

    for (const lock of locks) {
      lock.stopRenewal()
    }

    await Promise.all(locks.map(lock => lock.settled()))

    this.#events?.removeAllListeners()
  }

  async tryAcquire(key: string, options: AcquireOptions = {}): Promise<Lock | undefined> {
    const ttlMs = options.ttl === undefined ? this.options.ttlMs : toMillis(options.ttl)

    return traced(
      acquireChannel,
      () => this.#acquireContext(key, 'try', ttlMs, 0),
      ctx => this.#tryAcquire(key, ttlMs, options.renew === true, options.signal, ctx),
    )
  }

  async acquire(key: string, options: AcquireOptions = {}): Promise<Lock> {
    return this.#acquireTraced(key, options)
  }

  async withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    return traced(
      withLockChannel,
      (): Writable<WithLockContext> => ({ service: this, key }),
      ctx => this.#withLock(key, fn, options, ctx),
    )
  }

  async once<T>(key: string, fn: () => T | Promise<T>, options: OnceOptions = {}): Promise<OnceResult<T>> {
    const ttlMs = options.ttl === undefined ? this.options.ttlMs : toMillis(options.ttl)

    return traced(
      onceChannel,
      (): Writable<OnceContext> => ({ service: this, key, ttlMs }),
      ctx => this.#once(key, fn, ttlMs, options, ctx),
    )
  }

  #acquireTraced(key: string, options: AcquireOptions, parent?: WithLockContext): Promise<HeldLock> {
    const ttlMs = options.ttl === undefined ? this.options.ttlMs : toMillis(options.ttl)
    const waitMs = options.wait === undefined ? this.options.waitMs : toMillis(options.wait)

    return traced(
      acquireChannel,
      () => this.#acquireContext(key, 'wait', ttlMs, waitMs, parent),
      ctx => this.#acquire(key, ttlMs, waitMs, options, ctx),
    )
  }

  async #tryAcquire(
    key: string,
    ttlMs: number,
    renew: boolean,
    signal: AbortSignal | undefined,
    ctx: Writable<AcquireContext> | undefined,
  ): Promise<HeldLock | undefined> {
    const started = Date.now()

    let lease: LockLease | undefined
    try {
      lease = await this.#attempt(key, ttlMs, signal, 1)
    } catch (error) {
      this.#settleAcquire(ctx, key, signal?.aborted === true ? 'aborted' : 'error', 1, started)
      throw error
    }

    if (lease === undefined) {
      this.#settleAcquire(ctx, key, 'held', 1, started)
      return undefined
    }

    const lock = new HeldLock(this, lease, ttlMs, renew)
    this.#settleAcquire(ctx, key, 'acquired', 1, started, lock)

    return lock
  }

  async #acquire(
    key: string,
    ttlMs: number,
    waitMs: number,
    options: AcquireOptions,
    ctx: Writable<AcquireContext> | undefined,
  ): Promise<HeldLock> {
    const retryDelayMs = options.retryDelay === undefined ? this.options.retryDelayMs : toMillis(options.retryDelay)
    const started = Date.now()
    const deadline = started + waitMs
    const tally = { attempts: 0 }

    let lease: LockLease | undefined
    try {
      lease = await this.#retry(key, ttlMs, deadline, retryDelayMs, options.signal, tally)
    } catch (error) {
      this.#settleAcquire(ctx, key, options.signal?.aborted === true ? 'aborted' : 'error', tally.attempts, started)
      throw error
    }

    if (lease === undefined) {
      this.#settleAcquire(ctx, key, 'timeout', tally.attempts, started)
      throw new ErrLockNotAcquired(key, waitMs)
    }

    const lock = new HeldLock(this, lease, ttlMs, options.renew === true)
    this.#settleAcquire(ctx, key, 'acquired', tally.attempts, started, lock)

    return lock
  }

  // Attempts until the key is taken or the deadline passes, which is `undefined`. Counts into `tally` so a
  // caller that sees it throw still knows how many attempts were made.
  async #retry(
    key: string,
    ttlMs: number,
    deadline: number,
    retryDelayMs: number,
    signal: AbortSignal | undefined,
    tally: { attempts: number },
  ): Promise<LockLease | undefined> {
    for (;;) {
      signal?.throwIfAborted()

      tally.attempts += 1
      const lease = await this.#attempt(key, ttlMs, signal, tally.attempts)
      if (lease !== undefined) {
        return lease
      }

      const now = Date.now()
      if (now >= deadline) {
        return undefined
      }

      await sleep(Math.min(jittered(retryDelayMs, this.options.retryJitter), deadline - now), signal)
    }
  }

  // The one place the backend is asked for a key.
  async #attempt(
    key: string,
    ttlMs: number,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<LockLease | undefined> {
    let lease: LockLease | undefined
    try {
      lease = await this.backend.tryAcquire(key, ttlMs, signal)
    } catch (error) {
      // A backend that gave up because the caller aborted did nothing wrong.
      if (signal?.aborted !== true) {
        this.log.warn({ err: error, key, operation: 'acquire' }, 'lock backend failed')
      }

      throw error
    }

    if (lease === undefined) {
      this.log.trace({ key, attempt }, 'lock contended')
      publishContended(() => ({ service: this, key, attempt }))
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
    await lock.release()

    return result
  }

  async #once<T>(
    key: string,
    fn: () => T | Promise<T>,
    ttlMs: number,
    options: OnceOptions,
    ctx: Writable<OnceContext> | undefined,
  ): Promise<OnceResult<T>> {
    let lock: HeldLock | undefined
    try {
      lock = await traced(
        acquireChannel,
        () => this.#acquireContext(key, 'once', ttlMs, 0, ctx),
        actx => this.#tryAcquire(key, ttlMs, options.renew === true, options.signal, actx),
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
      result = await fn()
    } catch (error) {
      const lapsed = lock.lost
      const keep = options.releaseOnError === false
      // A release reports a lapse of its own; only a key left standing needs this call to say so.
      const warn = keep && lock.lapsedUnreported

      if (keep) {
        lock.stopRenewal()
      } else {
        await lock.release().catch(() => undefined)
      }

      this.#settleOnce(ctx, key, 'failed', lock, lapsed, warn)
      throw error
    }

    const lapsed = lock.lost
    const warn = lock.lapsedUnreported

    // Deliberately not released: what is left of the lease is the window, and it is what keeps the next
    // caller out as much as the concurrent one.
    lock.stopRenewal()
    this.#settleOnce(ctx, key, 'executed', lock, lapsed, warn)

    return { executed: true, result }
  }

  #acquireContext(
    key: string,
    mode: AcquireMode,
    ttlMs: number,
    waitMs: number,
    parent?: WithLockContext | OnceContext,
  ): Writable<AcquireContext> {
    return { service: this, key, mode, ttlMs, waitMs, parent }
  }

  #settleAcquire(
    ctx: Writable<AcquireContext> | undefined,
    key: string,
    outcome: AcquireOutcome,
    attempts: number,
    started: number,
    lock?: HeldLock,
  ): void {
    const waitedMs = Date.now() - started

    if (ctx !== undefined) {
      ctx.outcome = outcome
      ctx.attempts = attempts
      ctx.waitedMs = waitedMs

      if (lock !== undefined) {
        ctx.leaseID = lock.leaseID
        ctx.expiresAt = lock.expiresAt
      }
    }

    switch (outcome) {
      case 'acquired':
        this.log.debug({ key, leaseID: lock?.leaseID, attempts, waitedMs }, 'lock acquired')
        return
      case 'timeout':
        this.log.warn({ key, attempts, waitedMs }, 'lock acquisition timed out')
        return
      default:
        // `held` and `aborted` are ordinary answers; an `error` was already logged as a backend failure.
        this.log.debug({ key, outcome, attempts, waitedMs }, 'lock not acquired')
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

function settleHold(ctx: Writable<WithLockContext> | undefined, lock: HeldLock): void {
  if (ctx !== undefined) {
    ctx.heldMs = Date.now() - lock.acquiredAt
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
