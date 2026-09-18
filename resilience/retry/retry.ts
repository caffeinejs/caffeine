import { settled } from '../compose.js'
import { Emitter } from '../emitter.js'
import { ErrCallNotPermitted, ErrInvalidOption, ErrMaxRetriesExceeded } from '../errors.js'
import type { ExecutionContext, Next, StrategyObject } from '../strategy.js'
import { clampDelay } from '../timers.js'
import { sleep } from './_sleep.js'

/**
 * The delay before the next attempt. `attempt` is the attempt that just failed, starting at 1; `error` is what it
 * threw, or `result` what it returned when `retryOnResult` asked for another try. A `Backoff` fits.
 */
export type RetryBackoff = (attempt: number, error: unknown, result: unknown) => number

export interface RetryOptions {
  /** Names the retry in errors, events and metrics. */
  name: string
  /** Attempts in total, the first call included. Defaults to 3. */
  maxAttempts?: number
  /** Milliseconds between attempts, or a function of the failed attempt. Defaults to 500. */
  backoff?: number | RetryBackoff
  /**
   * Whether an error is worth another attempt. Defaults to every error except {@link ErrCallNotPermitted}, so an
   * open circuit breaker fails the call at once. A function given here replaces that default entirely.
   */
  retryOn?: (error: unknown, attempt: number) => boolean
  /** Whether a returned value is worth another attempt, such as a response with status 503. */
  retryOnResult?: (result: unknown) => boolean
  /**
   * What happens when the last attempt still returns a retryable value: `false`, the default, hands that value to
   * the caller; `true` rejects with {@link ErrMaxRetriesExceeded}. Either way the call counts as failed.
   */
  failAfterMaxAttempts?: boolean
}

/**
 * Lifetime counts, one per call, by whether it succeeded and whether it needed more than one attempt. A call that
 * used every attempt on a retryable result counts as failed, even when the caller received that result.
 */
export interface RetryMetrics {
  readonly successfulCallsWithoutRetry: number
  readonly successfulCallsWithRetry: number
  readonly failedCallsWithoutRetry: number
  readonly failedCallsWithRetry: number
}

export interface RetryEvents {
  /** Before sleeping ahead of the next attempt. `attempt` is the one that failed. */
  retry: {
    readonly name: string
    readonly attempt: number
    readonly delayMs: number
    readonly error?: unknown
    readonly result?: unknown
  }
  success: { readonly name: string; readonly attempts: number }
  /**
   * Every attempt was used. `result` is set instead of `error` when the last attempt still returned a retryable
   * value, whether the caller got that value back or {@link ErrMaxRetriesExceeded}.
   */
  failure: { readonly name: string; readonly attempts: number; readonly error?: unknown; readonly result?: unknown }
  /**
   * The call ended without using every attempt: the error was not retryable, the caller aborted, or `retryOn`,
   * `retryOnResult` or `backoff` threw, in which case `error` is what it threw.
   */
  ignored: { readonly name: string; readonly attempts: number; readonly error: unknown }
}

const retryAnythingButARefusal = (error: unknown): boolean => !(error instanceof ErrCallNotPermitted)

// One per call that needs a second attempt. It carries the resolvers of the promise the caller holds, so a later
// attempt settles that promise directly instead of resolving the attempt before it: the memory and the settle time
// of a call do not grow with the attempts it used.
interface RetriedCall<T> {
  readonly ctx: ExecutionContext
  readonly next: Next<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  attempt: number
}

/**
 * Runs the rest of the chain again when it fails, waiting between attempts.
 *
 * Once every attempt is used, the caller gets the last error unchanged. The caller's signal stops it: an abort
 * during a wait rejects at once with the abort reason, and a failure after an abort is not retried.
 */
export class Retry implements StrategyObject {
  readonly #name: string
  readonly #maxAttempts: number
  readonly #backoff: number | RetryBackoff
  readonly #retryOn: (error: unknown, attempt: number) => boolean
  readonly #retryOnResult: ((result: unknown) => boolean) | undefined
  readonly #failAfterMaxAttempts: boolean
  readonly #emitter = new Emitter<RetryEvents>()
  #successfulWithoutRetry = 0
  #successfulWithRetry = 0
  #failedWithoutRetry = 0
  #failedWithRetry = 0

  constructor(options: RetryOptions) {
    const name = (options as Partial<RetryOptions> | undefined)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption('Cannot create retry: name must be a non-empty string')
    }

    const invalid = (reason: string): ErrInvalidOption =>
      new ErrInvalidOption(`Cannot create retry "${name}": ${reason}`)

    const maxAttempts = options.maxAttempts ?? 3
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw invalid(`maxAttempts must be an integer of at least 1, got ${String(maxAttempts)}`)
    }

    const backoff = options.backoff ?? 500
    if (typeof backoff !== 'function' && (typeof backoff !== 'number' || !Number.isFinite(backoff) || backoff < 0)) {
      throw invalid(`backoff must be a finite number of at least 0 or a function, got ${String(backoff)}`)
    }

    for (const key of ['retryOn', 'retryOnResult'] as const) {
      if (options[key] !== undefined && typeof options[key] !== 'function') {
        throw invalid(`${key} must be a function, got ${typeof options[key]}`)
      }
    }

    const failAfterMaxAttempts = options.failAfterMaxAttempts ?? false
    if (typeof failAfterMaxAttempts !== 'boolean') {
      throw invalid(`failAfterMaxAttempts must be a boolean, got ${typeof failAfterMaxAttempts}`)
    }

    this.#name = name
    this.#maxAttempts = maxAttempts
    this.#backoff = backoff
    this.#retryOn = options.retryOn ?? retryAnythingButARefusal
    this.#retryOnResult = options.retryOnResult
    this.#failAfterMaxAttempts = failAfterMaxAttempts
  }

  get name(): string {
    return this.#name
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof RetryEvents>(type: K, listener: (event: RetryEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  metrics(): RetryMetrics {
    return {
      successfulCallsWithoutRetry: this.#successfulWithoutRetry,
      successfulCallsWithRetry: this.#successfulWithRetry,
      failedCallsWithoutRetry: this.#failedWithoutRetry,
      failedCallsWithRetry: this.#failedWithRetry,
    }
  }

  run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
    // The context is per call, so the attempt number is written in place instead of copying the context.
    ;(ctx as { attempt: number }).attempt = 1
    // The first attempt calls `next` from here, inside this frame's own `try`: a helper that called it would add a
    // frame to every stack trace, and `run` is public, so `next` may be one the chain never normalised. Only a call
    // that has to wait for another attempt goes through the retry path below.
    let pending: Promise<T>
    try {
      pending = settled(next(ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    return pending.then(
      result => (this.#retriesResult(1, result) ? this.#retrying(ctx, next, undefined, result, false) : result),
      error => {
        if (this.#retriesError(ctx, 1, error)) {
          return this.#retrying(ctx, next, error, undefined, true)
        }
        throw error
      },
    )
  }

  // Whether the result earns another attempt. `false` means the call is over and counted, and the caller gets the
  // result; a throw means the call is over, counted, and rejects with what was thrown.
  #retriesResult(attempt: number, result: unknown): boolean {
    let retryable: boolean
    try {
      retryable = this.#retryOnResult !== undefined && this.#retryOnResult(result)
    } catch (thrown) {
      this.#ignored(attempt, thrown)
      throw thrown
    }

    if (!retryable) {
      this.#succeeded(attempt)
      return false
    }
    if (attempt < this.#maxAttempts) {
      return true
    }

    this.#count(false, attempt)
    if (this.#emitter.has('failure')) {
      this.#emitter.emit('failure', { name: this.#name, attempts: attempt, result })
    }
    if (this.#failAfterMaxAttempts) {
      throw new ErrMaxRetriesExceeded(this.#name, attempt, result)
    }
    return false
  }

  // Whether the error earns another attempt. `false` means the call is over, counted, and rejects with `error`; a
  // throw means `retryOn` threw, and the call rejects with that instead.
  #retriesError(ctx: ExecutionContext, attempt: number, error: unknown): boolean {
    let retryable: boolean
    try {
      retryable = !(ctx.signal !== undefined && ctx.signal.aborted) && this.#retryOn(error, attempt)
    } catch (thrown) {
      this.#ignored(attempt, thrown)
      throw thrown
    }

    if (!retryable) {
      this.#ignored(attempt, error)
      return false
    }
    if (attempt < this.#maxAttempts) {
      return true
    }

    this.#count(false, attempt)
    if (this.#emitter.has('failure')) {
      this.#emitter.emit('failure', { name: this.#name, attempts: attempt, error })
    }
    return false
  }

  #retrying<T>(ctx: ExecutionContext, next: Next<T>, error: unknown, result: unknown, failed: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#wait({ ctx, next, resolve, reject, attempt: 1 }, error, result, failed)
    })
  }

  #wait<T>(call: RetriedCall<T>, error: unknown, result: unknown, failed: boolean): void {
    const attempt = call.attempt
    let delayMs: number
    try {
      delayMs = clampDelay(
        typeof this.#backoff === 'number' ? this.#backoff : this.#backoff(attempt, error, result),
        `retry "${this.#name}"`,
      )
    } catch (thrown) {
      this.#ignored(attempt, thrown)
      call.reject(thrown)
      return
    }

    if (this.#emitter.has('retry')) {
      this.#emitter.emit(
        'retry',
        failed ? { name: this.#name, attempt, delayMs, error } : { name: this.#name, attempt, delayMs, result },
      )
    }

    // Both handlers settle the caller's promise themselves, so the promise `then` returns is not needed.
    void sleep(delayMs, call.ctx.signal).then(
      () => this.#again(call),
      reason => {
        this.#ignored(attempt, reason)
        call.reject(reason)
      },
    )
  }

  #again<T>(call: RetriedCall<T>): void {
    const attempt = ++call.attempt
    ;(call.ctx as { attempt: number }).attempt = attempt
    // Guarded like the first attempt, and called from this frame: a helper would add a frame to every stack trace.
    let pending: Promise<T>
    try {
      pending = settled(call.next(call.ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    // Both handlers settle the caller's promise themselves and never throw.
    void pending.then(
      result => {
        try {
          if (this.#retriesResult(attempt, result)) {
            this.#wait(call, undefined, result, false)
          } else {
            call.resolve(result)
          }
        } catch (thrown) {
          call.reject(thrown)
        }
      },
      error => {
        try {
          if (this.#retriesError(call.ctx, attempt, error)) {
            this.#wait(call, error, undefined, true)
          } else {
            call.reject(error)
          }
        } catch (thrown) {
          call.reject(thrown)
        }
      },
    )
  }

  #succeeded(attempts: number): void {
    this.#count(true, attempts)
    if (this.#emitter.has('success')) {
      this.#emitter.emit('success', { name: this.#name, attempts })
    }
  }

  #ignored(attempts: number, error: unknown): void {
    this.#count(false, attempts)
    if (this.#emitter.has('ignored')) {
      this.#emitter.emit('ignored', { name: this.#name, attempts, error })
    }
  }

  #count(succeeded: boolean, attempts: number): void {
    if (succeeded) {
      if (attempts > 1) {
        this.#successfulWithRetry++
      } else {
        this.#successfulWithoutRetry++
      }
    } else if (attempts > 1) {
      this.#failedWithRetry++
    } else {
      this.#failedWithoutRetry++
    }
  }
}

/**
 * Creates a {@link Retry}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function retry(options: RetryOptions): Retry {
  return new Retry(options)
}
