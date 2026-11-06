import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { exponential } from '../backoff.js'
import { lift, mark } from '../compose.js'
import { disposable } from '../dispose.js'
import { detached, Emitter } from '../emitter.js'
import { described, ErrCallRefused, type ErrorClass, ErrInvalidOption, ErrResilience } from '../errors.js'
import { Options } from '../options.js'
import type { CallContext, Operation, Wrapper } from '../policy.js'
import { clampDelay, type Clock } from '../timers.js'
import { sleep } from './_sleep.js'

/**
 * A call ended on a result the retry was told to retry, and the retry was told to fail rather than hand the last one
 * back, or that result already went to `discard`. The call ends so when every attempt was used, and also when the
 * next attempt was refused or the retry was disposed while the call waited. The last result is in `result`.
 */
export class ErrMaxRetriesExceeded extends ErrResilience {
  readonly attempts: number
  /**
   * The last retryable result. It is not enumerable, so a logger that copies an error's fields leaves out what the
   * dependency answered.
   */
  declare readonly result: unknown

  /** `ending` says why the call ended: every attempt was used, the next one was refused, or the retry was disposed. */
  constructor(
    retry: string,
    attempts: number,
    result: unknown,
    ending: 'exhausted' | 'refused' | 'disposed' = 'exhausted',
  ) {
    super(
      errMessage(`Cannot complete "${retry}": ${endingReason(attempts, ending)}`)
        .reference('@caffeinejs/resilience', ErrMaxRetriesExceeded)
        .build(),
      'ERR_MAX_RETRIES_EXCEEDED',
    )
    this.name = 'ErrMaxRetriesExceeded'
    this.attempts = attempts
    Object.defineProperty(this, 'result', { value: result, enumerable: false })
  }
}

function endingReason(attempts: number, ending: 'exhausted' | 'refused' | 'disposed'): string {
  switch (ending) {
    case 'exhausted':
      return `result still retryable after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`
    case 'refused':
      return `attempt ${attempts + 1} was refused after attempt ${attempts} returned a retryable result`
    case 'disposed':
      return `retry was disposed before attempt ${attempts + 1}, after attempt ${attempts} returned a retryable result`
  }
}

/**
 * The delay before the next attempt. `attempt` is the attempt that just failed, starting at 1; `error` is what it
 * threw, or `result` what it returned when `retryOnResult` asked for another try. A `Backoff` fits.
 */
export type RetryBackoff = (attempt: number, error: unknown, result: unknown) => Duration

export interface RetryOptions {
  /** Names the retry in errors, events and metrics. */
  name: string
  /** Attempts in total, the first call included. Defaults to 3. */
  maxAttempts?: number
  /**
   * The wait between attempts, or a function of the failed attempt. Defaults to `exponential()`: 500 milliseconds,
   * doubling per attempt up to 30 seconds, each wait spread by half of it either way.
   */
  backoff?: Duration | RetryBackoff
  /**
   * Which errors are worth another attempt: a predicate of the error and the attempt that failed, or a list of error
   * classes. Defaults to every error.
   *
   * A refusal ({@link ErrCallRefused}: an open circuit breaker, a full bulkhead, a spent rate limit), a failure
   * after the caller aborted and a client error (`CallContext.isClientError`) are never retried, whatever this says.
   * A refusal after an attempt that reached the operation ends the call with that attempt's outcome, as if it had been
   * the last. A predicate must return a boolean; anything else rejects the call with {@link ErrInvalidOption}.
   */
  retryOn?: ((error: unknown, attempt: number) => boolean) | readonly ErrorClass[]
  /**
   * Whether a returned value is worth another attempt, such as a response with status 503. It must return a
   * boolean; anything else rejects the call with {@link ErrInvalidOption}.
   */
  retryOnResult?: (result: unknown) => boolean
  /**
   * What happens when the last attempt still returns a retryable value: `false`, the default, hands that value to
   * the caller; `true` rejects with {@link ErrMaxRetriesExceeded}. Either way the call counts as failed.
   */
  failAfterMaxAttempts?: boolean
  /**
   * Releases a result the retry tries again, such as a 503 response whose body would otherwise hold its connection
   * while the retry waits: `discard: response => response.body?.cancel()`. It runs before the wait, after the `retry`
   * event. The call never waits for it, and what it throws or rejects with is dropped.
   *
   * A result it released never reaches the caller. When a later attempt is refused, or the retry is disposed while the
   * call waits, the call rejects with {@link ErrMaxRetriesExceeded}, which carries the result, instead of resolving
   * with it.
   */
  discard?: (result: unknown) => unknown
  /** Where the retry sets the timers it waits on. Defaults to the runtime's. */
  clock?: Clock
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
    readonly delay: Duration
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
   * The call ended without using every attempt: the error was not retryable, the caller aborted, `retryOn`,
   * `retryOnResult` or `backoff` threw, in which case `error` is what it threw, or the retry was disposed, in which
   * case `error` or `result` is the last attempt's outcome.
   */
  ignored: { readonly name: string; readonly attempts: number; readonly error?: unknown; readonly result?: unknown }
}

// One per call that needs a second attempt. It carries the resolvers of the promise the caller holds, so a later
// attempt settles that promise directly instead of resolving the attempt before it: the memory and the settle time
// of a call do not grow with the attempts it used.
interface RetriedCall<T, I> {
  readonly ctx: CallContext
  readonly inner: Operation<T, I>
  readonly input: I
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  attempt: number
  // The outcome of the last attempt that reached the operation: a refusal after it ends the call with this instead.
  failed: boolean
  error: unknown
  result: unknown
  // Ends the wait for the next attempt without starting it; set while the call waits.
  cancel: (() => void) | undefined
}

/**
 * Runs the rest of the chain again when it fails, waiting between attempts.
 *
 * Once every attempt is used, the caller gets the last error unchanged. The caller's signal stops it: an abort
 * during a wait rejects at once with the abort reason, and a failure after an abort is not retried.
 */
export class Retry implements Wrapper {
  declare [Symbol.dispose]: () => void
  readonly #name: string
  readonly #maxAttempts: number
  readonly #backoff: Duration | RetryBackoff
  readonly #retryOn: ((error: unknown, attempt: number) => boolean) | undefined
  readonly #retryOnResult: ((result: unknown) => boolean) | undefined
  readonly #failAfterMaxAttempts: boolean
  readonly #discard: ((result: unknown) => unknown) | undefined
  readonly #clock: Clock
  readonly #emitter = new Emitter<RetryEvents>()
  readonly #waiting = new Set<RetriedCall<unknown, unknown>>()
  #disposed = false
  #successfulWithoutRetry = 0
  #successfulWithRetry = 0
  #failedWithoutRetry = 0
  #failedWithRetry = 0

  constructor(options: RetryOptions) {
    const o = new Options('retry', options)
    this.#name = o.name
    this.#maxAttempts = o.integer('maxAttempts', options.maxAttempts ?? 3, 1)

    const backoff = options.backoff ?? exponential()
    if (typeof backoff !== 'function' && (typeof backoff !== 'number' || !Number.isFinite(backoff) || backoff < 0)) {
      throw o.invalid(`backoff must be a finite Duration of at least 0s or a function, got ${formatDuration(backoff)}`)
    }
    this.#backoff = backoff
    this.#retryOn = o.matcher('retryOn', options.retryOn)
    this.#retryOnResult = o.function('retryOnResult', options.retryOnResult)
    this.#failAfterMaxAttempts = o.boolean('failAfterMaxAttempts', options.failAfterMaxAttempts, false)
    this.#discard = o.function('discard', options.discard)
    this.#clock = o.clock(options.clock)
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

  /**
   * Ends every call waiting for its next attempt now, with that call's last outcome, and from then on ends a call at
   * once where it would wait, so no backoff holds a shutdown. The `[Symbol.dispose]` alias does the same.
   */
  dispose(): void {
    this.#disposed = true
    // Taken out of the set before any ends, so a listener that disposes again finds none left to end.
    const waiting = [...this.#waiting]
    this.#waiting.clear()
    for (const call of waiting) {
      call.cancel?.()
    }
    for (const call of waiting) {
      this.#endDisposed(call, this.#discard !== undefined)
    }
  }

  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I> {
    const inner = lift(op)
    // Only a call that has to wait for another attempt goes through the retry path below.
    return mark((ctx, input) =>
      inner(ctx, input).then(
        result =>
          this.#retriesResult(1, result) ? this.#retrying(ctx, inner, input, undefined, result, false) : result,
        error => {
          if (this.#retriesError(ctx, 1, error)) {
            return this.#retrying(ctx, inner, input, error, undefined, true)
          }
          throw error
        },
      ),
    )
  }

  // Whether the result earns another attempt. `false` means the call is over and counted, and the caller gets the
  // result; a throw means the call is over, counted, and rejects with what was thrown.
  #retriesResult(attempt: number, result: unknown): boolean {
    let retryable: boolean
    try {
      retryable = this.#retryOnResult !== undefined && this.#verdict('retryOnResult', this.#retryOnResult(result))
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
  #retriesError(ctx: CallContext, attempt: number, error: unknown): boolean {
    let retryable: boolean
    try {
      retryable =
        !(ctx.signal !== undefined && ctx.signal.aborted) &&
        !(error instanceof ErrCallRefused) &&
        !ctx.isClientError?.(error) &&
        (this.#retryOn === undefined || this.#verdict('retryOn', this.#retryOn(error, attempt)))
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

  // A predicate's answer, refused unless it is a boolean: a promise is truthy, so an async predicate would retry
  // whatever it resolved to.
  #verdict(key: 'retryOn' | 'retryOnResult', value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new ErrInvalidOption(
        errMessage(`Cannot run retry "${this.#name}": ${key} must return a boolean, got ${described(value)}`)
          .solutions(`Return true or false from ${key}: an async function returns a promise, which is not one`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    return value
  }

  #retrying<T, I>(
    ctx: CallContext,
    inner: Operation<T, I>,
    input: I,
    error: unknown,
    result: unknown,
    failed: boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#wait(
        { ctx, inner, input, resolve, reject, attempt: 1, failed, error, result, cancel: undefined },
        error,
        result,
        failed,
      )
    })
  }

  #wait<T, I>(call: RetriedCall<T, I>, error: unknown, result: unknown, failed: boolean): void {
    const attempt = call.attempt
    call.failed = failed
    call.error = error
    call.result = result
    if (this.#disposed) {
      this.#endDisposed(call, false)
      return
    }

    let delay: Duration
    try {
      delay = clampDelay(
        typeof this.#backoff === 'number' ? this.#backoff : this.#backoff(attempt, error, result),
        `retry "${this.#name}"`,
      )
    } catch (thrown) {
      this.#ignored(attempt, thrown)
      call.reject(thrown)
      return
    }
    // A backoff function, a `retry` listener or `discard` may dispose the retry before the call joins the ones dispose()
    // ends: each is checked for, so no call waits after dispose() returns.
    if (this.#disposed) {
      this.#endDisposed(call, false)
      return
    }

    if (this.#emitter.has('retry')) {
      this.#emitter.emit(
        'retry',
        failed ? { name: this.#name, attempt, delay, error } : { name: this.#name, attempt, delay, result },
      )
      if (this.#disposed) {
        this.#endDisposed(call, false)
        return
      }
    }

    const discard = failed ? undefined : this.#discard
    if (discard !== undefined) {
      detached(discard, result)
    }
    if (this.#disposed) {
      this.#endDisposed(call, discard !== undefined)
      return
    }

    const waiting = call as RetriedCall<unknown, unknown>
    this.#waiting.add(waiting)
    call.cancel = sleep(
      delay,
      call.ctx.signal,
      this.#clock,
      () => {
        this.#waiting.delete(waiting)
        this.#again(call)
      },
      reason => {
        this.#waiting.delete(waiting)
        this.#ignored(attempt, reason)
        call.reject(reason)
      },
    )
  }

  #again<T, I>(call: RetriedCall<T, I>): void {
    const attempt = ++call.attempt
    // Both handlers settle the caller's promise themselves and never throw.
    void call.inner(call.ctx, call.input).then(
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
          } else if (error instanceof ErrCallRefused) {
            this.#endRefused(call)
          } else {
            call.reject(error)
          }
        } catch (thrown) {
          call.reject(thrown)
        }
      },
    )
  }

  // A refusal promises the operation did not run, which an earlier attempt that reached it makes false for the call:
  // the caller gets that attempt's outcome, as if it had been the last one.
  #endRefused<T, I>(call: RetriedCall<T, I>): void {
    this.#endWithLast(call, call.attempt - 1, this.#discard !== undefined, 'refused')
  }

  // Disposal ends the call before its next attempt, with the outcome of the one before.
  #endDisposed<T, I>(call: RetriedCall<T, I>, discarded: boolean): void {
    this.#count(false, call.attempt)
    if (this.#emitter.has('ignored')) {
      this.#emitter.emit(
        'ignored',
        call.failed
          ? { name: this.#name, attempts: call.attempt, error: call.error }
          : { name: this.#name, attempts: call.attempt, result: call.result },
      )
    }
    this.#endWithLast(call, call.attempt, discarded, 'disposed')
  }

  // A result that went to `discard` is not handed back: the error carries it instead.
  #endWithLast<T, I>(
    call: RetriedCall<T, I>,
    attempts: number,
    discarded: boolean,
    ending: 'refused' | 'disposed',
  ): void {
    if (call.failed) {
      call.reject(call.error)
    } else if (this.#failAfterMaxAttempts || discarded) {
      call.reject(new ErrMaxRetriesExceeded(this.#name, attempts, call.result, ending))
    } else {
      call.resolve(call.result as T)
    }
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

disposable(Retry)

/**
 * Creates a {@link Retry}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function retry(options: RetryOptions): Retry {
  return new Retry(options)
}
