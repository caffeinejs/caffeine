import { type OnDestroy } from '@caffeinejs/di'
import { toMillis, type Duration } from '@caffeinejs/std'

import { HeldLock, type LockHost } from './_lock.js'
import { type Backend } from './backend.js'
import { ErrLockNotAcquired } from './errors.js'
import { type DistLockOptions } from './options.js'

/** A lease this process currently holds. */
export interface Lock {
  readonly key: string
  readonly token: string

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
 * `'30s'` spellings before it binds, so nothing here parses a duration.
 *
 * Waiting, retrying, backoff and jitter all happen here rather than in the backend, which only ever makes one
 * attempt.
 */
export class CaffeineDistLock implements DistLock, LockHost, OnDestroy {
  readonly backend: Backend
  readonly options: DistLockOptions

  readonly #renewing = new Set<HeldLock>()

  constructor(backend: Backend, options: DistLockOptions) {
    this.backend = backend
    this.options = options
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
   * adapter can be torn down after.
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
  }

  async tryAcquire(key: string, options: AcquireOptions = {}): Promise<Lock | undefined> {
    const ttlMs = options.ttl === undefined ? this.options.ttlMs : toMillis(options.ttl)
    const lease = await this.backend.tryAcquire(key, ttlMs, options.signal)

    return lease === undefined ? undefined : new HeldLock(this, lease, ttlMs, options.renew === true)
  }

  async acquire(key: string, options: AcquireOptions = {}): Promise<Lock> {
    const waitMs = options.wait === undefined ? this.options.waitMs : toMillis(options.wait)
    const retryDelayMs = options.retryDelay === undefined ? this.options.retryDelayMs : toMillis(options.retryDelay)
    const deadline = Date.now() + waitMs

    for (;;) {
      options.signal?.throwIfAborted()

      const lock = await this.tryAcquire(key, options)
      if (lock !== undefined) {
        return lock
      }

      const now = Date.now()
      if (now >= deadline) {
        throw new ErrLockNotAcquired(key, waitMs)
      }

      await sleep(Math.min(jittered(retryDelayMs, this.options.retryJitter), deadline - now), options.signal)
    }
  }

  async withLock<T>(key: string, fn: (lock: Lock) => T | Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const lock = await this.acquire(key, options)
    let result: T

    try {
      result = await fn(lock)
    } catch (error) {
      // The action's failure is what the caller asked about, so a release that also fails stays quiet here.
      await lock.release().catch(() => undefined)
      throw error
    }

    await lock.release()

    return result
  }

  async once<T>(key: string, fn: () => T | Promise<T>, options: OnceOptions = {}): Promise<OnceResult<T>> {
    const ttlMs = options.ttl === undefined ? this.options.ttlMs : toMillis(options.ttl)
    const lease = await this.backend.tryAcquire(key, ttlMs, options.signal)

    if (lease === undefined) {
      return { executed: false }
    }

    const lock = new HeldLock(this, lease, ttlMs, options.renew === true)

    let result: T
    try {
      result = await fn()
    } catch (error) {
      if (options.releaseOnError === false) {
        lock.stopRenewal()
      } else {
        await lock.release().catch(() => undefined)
      }

      throw error
    }

    // Deliberately not released: what is left of the lease is the window, and it is what keeps the next
    // caller out as much as the concurrent one.
    lock.stopRenewal()

    return { executed: true, result }
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
