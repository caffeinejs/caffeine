import { errMessage } from '@caffeinejs/std/err'

import { lift, mark } from '../compose.js'
import { Emitter } from '../emitter.js'
import { described, type ErrorMatcher, ErrInvalidOption } from '../errors.js'
import { Options } from '../options.js'
import type { Operation, RecoveryWrapper } from '../policy.js'

/**
 * What answers a failed call: it receives the error and the call's input, such as the arguments of a decorated
 * function, and returns the value the caller gets instead.
 */
export type FallbackHandler<R> = (error: unknown, input: unknown) => R | PromiseLike<R>

export interface FallbackOptions {
  /** Names the fallback in events and metrics. Defaults to `fallback`. */
  name?: string
  /**
   * Which errors the handler answers: a predicate, or a list of error classes. Defaults to every error, a programming
   * error such as a `TypeError` included. A predicate must return a boolean; anything else rejects the call with
   * {@link ErrInvalidOption}.
   */
  on?: ErrorMatcher
}

/** Lifetime counts, one per call, by how it ended. */
export interface FallbackMetrics {
  /** The call succeeded; the handler did not run. */
  readonly successfulCalls: number
  /** The call failed and the handler's value took its place. */
  readonly recoveredCalls: number
  /** The handler threw, or `on` did. */
  readonly failedCalls: number
  /** The call failed with an error the fallback does not handle, or after the caller aborted. */
  readonly ignoredCalls: number
}

export interface FallbackEvents {
  recovered: { readonly name: string; readonly error: unknown }
  /** `thrown` is what the handler, or `on`, threw; `error` is the call's error it was handling. */
  failure: { readonly name: string; readonly error: unknown; readonly thrown: unknown }
  ignored: { readonly name: string; readonly error: unknown; readonly reason: 'not_handled' | 'aborted' }
}

/**
 * Answers a failed call with what its handler returns, so the caller gets a value instead of the error. It widens
 * the result type, so it sits outermost: `compose(fallback(() => CACHED), retries, breaker)`.
 *
 * An error `on` declines passes through unchanged, and so does any error once the caller's signal has aborted:
 * nobody is waiting for the answer. A handler that throws rejects the call with what it threw.
 */
export class Fallback<R = unknown> implements RecoveryWrapper<R> {
  declare readonly recovers?: R
  readonly #name: string
  readonly #handler: FallbackHandler<R>
  readonly #on: ((error: unknown) => boolean) | undefined
  readonly #emitter = new Emitter<FallbackEvents>()
  #successful = 0
  #recovered = 0
  #failed = 0
  #ignored = 0

  constructor(handler: FallbackHandler<R>, options: FallbackOptions = {}) {
    const o = new Options('fallback', { ...options, name: options.name ?? 'fallback' })
    if (typeof handler !== 'function') {
      throw o.invalid(`handler must be a function, got ${typeof handler}`)
    }

    this.#name = o.name
    this.#handler = handler
    this.#on = o.matcher('on', options.on)
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

  wrap<T, I = void>(op: Operation<T, I>): Operation<T | R, I> {
    const inner = lift(op)
    return mark<T | R, I>((ctx, input) =>
      inner(ctx, input).then(
        value => {
          this.#successful++
          return value
        },
        error => this.#onError(error, ctx.signal, input),
      ),
    )
  }

  #onError(error: unknown, signal: AbortSignal | undefined, input: unknown): Promise<R> {
    if (signal !== undefined && signal.aborted) {
      this.#ignore(error, 'aborted')
      return Promise.reject(error)
    }

    let handled: unknown
    try {
      handled = this.#on === undefined || this.#on(error)
      if (typeof handled !== 'boolean') {
        throw new ErrInvalidOption(
          errMessage(`Cannot run fallback "${this.#name}": on must return a boolean, got ${described(handled)}`)
            .solutions('Return true or false from on: an async function returns a promise, which is not one')
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
      answer = this.#handler(error, input)
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
 * Creates a {@link Fallback} that answers with what `handler` returns.
 *
 * @throws {@link ErrInvalidOption} when `handler` is not a function or an option is invalid.
 */
export function fallback<R>(handler: FallbackHandler<R>, options?: FallbackOptions): Fallback<R> {
  return new Fallback(handler, options)
}
