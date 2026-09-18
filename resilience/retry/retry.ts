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
   * the caller; `true` rejects with {@link ErrMaxRetriesExceeded}.
   */
  failAfterMaxAttempts?: boolean
}

/** Lifetime counts, one per call, by whether it succeeded and whether it needed more than one attempt. */
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
  /** Every attempt was used. `result` is set instead of `error` when `failAfterMaxAttempts` rejected a value. */
  failure: { readonly name: string; readonly attempts: number; readonly error?: unknown; readonly result?: unknown }
  /** The call ended without using every attempt: the error was not retryable, or the caller aborted. */
  ignored: { readonly name: string; readonly attempts: number; readonly error: unknown }
}

const retryAnythingButARefusal = (error: unknown): boolean => !(error instanceof ErrCallNotPermitted)

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
    // that has to wait for another attempt goes through an async function.
    let pending: Promise<T>
    try {
      pending = settled(next(ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    return pending.then(
      result => this.#afterResult(ctx, next, 1, result),
      error => this.#afterError(ctx, next, 1, error),
    )
  }

  #afterResult<T>(ctx: ExecutionContext, next: Next<T>, attempt: number, result: T): T | Promise<T> {
    if (this.#retryOnResult === undefined || !this.#retryOnResult(result)) {
      this.#succeeded(attempt)
      return result
    }

    if (attempt >= this.#maxAttempts) {
      if (!this.#failAfterMaxAttempts) {
        this.#succeeded(attempt)
        return result
      }

      this.#count(false, attempt)
      if (this.#emitter.has('failure')) {
        this.#emitter.emit('failure', { name: this.#name, attempts: attempt, result })
      }
      throw new ErrMaxRetriesExceeded(this.#name, attempt, result)
    }

    return this.#retry(ctx, next, attempt, undefined, result, false)
  }

  #afterError<T>(ctx: ExecutionContext, next: Next<T>, attempt: number, error: unknown): Promise<T> {
    if ((ctx.signal !== undefined && ctx.signal.aborted) || !this.#retryOn(error, attempt)) {
      this.#ignored(attempt, error)
      throw error
    }

    if (attempt >= this.#maxAttempts) {
      this.#count(false, attempt)
      if (this.#emitter.has('failure')) {
        this.#emitter.emit('failure', { name: this.#name, attempts: attempt, error })
      }
      throw error
    }

    return this.#retry(ctx, next, attempt, error, undefined, true)
  }

  async #retry<T>(
    ctx: ExecutionContext,
    next: Next<T>,
    attempt: number,
    error: unknown,
    result: unknown,
    failed: boolean,
  ): Promise<T> {
    const delayMs = clampDelay(
      typeof this.#backoff === 'number' ? this.#backoff : this.#backoff(attempt, error, result),
      `retry "${this.#name}"`,
    )

    if (this.#emitter.has('retry')) {
      this.#emitter.emit(
        'retry',
        failed ? { name: this.#name, attempt, delayMs, error } : { name: this.#name, attempt, delayMs, result },
      )
    }

    try {
      await sleep(delayMs, ctx.signal)
    } catch (reason) {
      this.#ignored(attempt, reason)
      throw reason
    }

    const current = attempt + 1
    ;(ctx as { attempt: number }).attempt = current
    // Guarded like the first attempt: an async function would turn a synchronous throw into its own rejection, and
    // the attempt would be neither counted nor retried.
    let pending: Promise<T>
    try {
      pending = settled(next(ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    return pending.then(
      result => this.#afterResult(ctx, next, current, result),
      error => this.#afterError(ctx, next, current, error),
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
