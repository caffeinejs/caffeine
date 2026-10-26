import { errMessage } from '@caffeinejs/std/err'

import { Emitter } from '../emitter.js'
import { described, ErrInvalidOption } from '../errors.js'

export interface FallbackOptions {
  /** Names the fallback in events and metrics. */
  name: string
  /**
   * Whether an error is handed to the handler. Defaults to every error. It must return a boolean; anything else
   * rejects the call with {@link ErrInvalidOption}.
   */
  fallbackOn?: (error: unknown) => boolean
}

/** Lifetime counts, one per call, by how it ended. */
export interface FallbackMetrics {
  /** The call succeeded; the handler did not run. */
  readonly successfulCalls: number
  /** The call failed and the handler's value took its place. */
  readonly recoveredCalls: number
  /** The handler threw, or `fallbackOn` did. */
  readonly failedCalls: number
  /** The call failed with an error the fallback does not handle, or after the caller aborted. */
  readonly ignoredCalls: number
}

export interface FallbackEvents {
  recovered: { readonly name: string; readonly error: unknown }
  /** `thrown` is what the handler, or `fallbackOn`, threw; `error` is the call's error it was handling. */
  failure: { readonly name: string; readonly error: unknown; readonly thrown: unknown }
  ignored: { readonly name: string; readonly error: unknown; readonly reason: 'not_handled' | 'aborted' }
}

/**
 * What a call answers when it fails: which errors it handles, plus events and metrics, shared by every call that
 * uses it. Each call hands it the promise to watch and the handler for that call.
 *
 * It never runs after the caller's signal aborted.
 */
export class Fallback {
  readonly #name: string
  readonly #fallbackOn: ((error: unknown) => boolean) | undefined
  readonly #emitter = new Emitter<FallbackEvents>()
  #successful = 0
  #recovered = 0
  #failed = 0
  #ignored = 0

  constructor(options: FallbackOptions) {
    const name = (options as Partial<FallbackOptions> | undefined)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption(
        errMessage('Cannot create fallback: name must be a non-empty string')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    if (options.fallbackOn !== undefined && typeof options.fallbackOn !== 'function') {
      throw new ErrInvalidOption(
        errMessage(`Cannot create fallback "${name}": fallbackOn must be a function, got ${typeof options.fallbackOn}`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    this.#name = name
    this.#fallbackOn = options.fallbackOn
  }

  get name(): string {
    return this.#name
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof FallbackEvents>(type: K, listener: (event: FallbackEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  metrics(): FallbackMetrics {
    return {
      successfulCalls: this.#successful,
      recoveredCalls: this.#recovered,
      failedCalls: this.#failed,
      ignoredCalls: this.#ignored,
    }
  }

  /**
   * The call's value, or, when it fails with an error `fallbackOn` accepts, what `handler` returns for that error.
   *
   * An error the fallback does not handle passes through unchanged, and so does any error once `signal` has aborted.
   * A handler that throws rejects the call with what it threw.
   */
  recover<T, R>(
    call: PromiseLike<T>,
    handler: (error: unknown) => R | PromiseLike<R>,
    signal?: AbortSignal,
  ): Promise<T | R> {
    if (typeof handler !== 'function') {
      // The call's own outcome is still observed: left alone, a failing call would surface as an unhandled rejection.
      Promise.resolve(call).then(undefined, () => undefined)
      return Promise.reject(
        new ErrInvalidOption(
          errMessage(
            `Cannot recover with fallback "${this.#name}": the handler must be a function, got ${typeof handler}`,
          )
            .reference('@caffeinejs/resilience', ErrInvalidOption)
            .build(),
        ),
      )
    }

    return Promise.resolve(call).then(
      value => {
        this.#successful++
        return value
      },
      error => this.#onError(error, handler, signal),
    )
  }

  #onError<R>(
    error: unknown,
    handler: (error: unknown) => R | PromiseLike<R>,
    signal: AbortSignal | undefined,
  ): Promise<R> {
    if (signal !== undefined && signal.aborted) {
      this.#ignore(error, 'aborted')
      return Promise.reject(error)
    }

    let handled: unknown
    try {
      handled = this.#fallbackOn === undefined || this.#fallbackOn(error)
      if (typeof handled !== 'boolean') {
        throw new ErrInvalidOption(
          errMessage(`Cannot run fallback "${this.#name}": fallbackOn must return a boolean, got ${described(handled)}`)
            .solutions('Return true or false from fallbackOn: an async function returns a promise, which is not one')
            .reference('@caffeinejs/resilience', ErrInvalidOption)
            .build(),
        )
      }
    } catch (thrown) {
      this.#fail(error, thrown)
      return Promise.reject(thrown)
    }

    if (!handled) {
      this.#ignore(error, 'not_handled')
      return Promise.reject(error)
    }

    let answer: R | PromiseLike<R>
    try {
      answer = handler(error)
    } catch (thrown) {
      this.#fail(error, thrown)
      return Promise.reject(thrown)
    }

    return Promise.resolve(answer).then(
      value => {
        this.#recovered++
        if (this.#emitter.has('recovered')) {
          this.#emitter.emit('recovered', { name: this.#name, error })
        }
        return value
      },
      (thrown: unknown) => {
        this.#fail(error, thrown)
        throw thrown
      },
    )
  }

  #ignore(error: unknown, reason: 'not_handled' | 'aborted'): void {
    this.#ignored++
    if (this.#emitter.has('ignored')) {
      this.#emitter.emit('ignored', { name: this.#name, error, reason })
    }
  }

  #fail(error: unknown, thrown: unknown): void {
    this.#failed++
    if (this.#emitter.has('failure')) {
      this.#emitter.emit('failure', { name: this.#name, error, thrown })
    }
  }
}

/**
 * Creates a {@link Fallback}.
 *
 * @throws {@link ErrInvalidOption} when an option is invalid.
 */
export function fallback(options: FallbackOptions): Fallback {
  return new Fallback(options)
}
