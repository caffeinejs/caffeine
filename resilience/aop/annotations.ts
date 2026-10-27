import { type Annotation, createAnnotation } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { described, ErrInvalidOption } from '../errors.js'

// A strategy settles a call later, so only a method that returns a promise can carry one.
type AsyncMethod<This, A extends unknown[], R> = (this: This, ...args: A) => Promise<R>

type AsyncMethodDecorator = <This, A extends unknown[], R>(
  target: AsyncMethod<This, A, R>,
  context: ClassMethodDecoratorContext<This, AsyncMethod<This, A, R>>,
) => void

// `This` must hold a method named `K` taking the error, then the decorated method's arguments, and resolving to what
// the decorated method resolves to.
type FallbackDecorator<K extends string | symbol> = <
  This extends { [P in K]: (error: unknown, ...args: A) => Promise<R> },
  A extends unknown[],
  R,
>(
  target: AsyncMethod<This, A, R>,
  context: ClassMethodDecoratorContext<This, AsyncMethod<This, A, R>>,
) => void

export interface RetryAnnotationOptions {
  /**
   * Declares that running the method twice is safe. An HTTP handler routed for a method that is not safe may carry
   * `@Retry` only when it says so, unless the application allows that method; it deduplicates nothing.
   */
  readonly repeatable?: boolean
}

/** What `@Retry` stores. */
export interface RetryAnnotation {
  readonly name: string
  readonly repeatable: boolean
}

export interface FallbackAnnotationOptions {
  /** Whether an error is handed to the fallback method. Defaults to every error. */
  readonly fallbackOn?: (error: unknown) => boolean
}

/** What `@Fallback` stores. */
export interface FallbackAnnotation {
  readonly method: string | symbol
  readonly fallbackOn: ((error: unknown) => boolean) | undefined
}

function nameOf(decorator: string, name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ErrInvalidOption(
      errMessage(
        `Cannot apply @${decorator}: the name must be a non-empty string, got ${typeof name === 'string' ? '""' : described(name)}`,
      )
        .solutions(
          `Name the instance defined with Resilience(r => r.${decorator[0]!.toLowerCase()}${decorator.slice(1)}('name', { ... }))`,
        )
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  return name
}

/**
 * Runs the method again when it fails, with the retry of that name defined by the `Resilience()` feature.
 *
 * Retrying a method repeats everything it does.
 */
export const Retry = createAnnotation.on('method')(
  (name: string, options?: RetryAnnotationOptions): RetryAnnotation => ({
    name: nameOf('Retry', name),
    repeatable: options?.repeatable ?? false,
  }),
) as unknown as ((name: string, options?: RetryAnnotationOptions) => AsyncMethodDecorator) &
  Annotation<RetryAnnotation, 'method'>

/** Guards the method with the circuit breaker of that name defined by the `Resilience()` feature. */
export const CircuitBreaker = createAnnotation.on('method')((name: string): string =>
  nameOf('CircuitBreaker', name),
) as unknown as ((name: string) => AsyncMethodDecorator) & Annotation<string, 'method'>

/** Bounds how long the method may run, with the time limiter of that name defined by the `Resilience()` feature. */
export const TimeLimiter = createAnnotation.on('method')((name: string): string =>
  nameOf('TimeLimiter', name),
) as unknown as ((name: string) => AsyncMethodDecorator) & Annotation<string, 'method'>

/** Limits how many calls of the method run at once, with the bulkhead of that name defined by `Resilience()`. */
export const Bulkhead = createAnnotation.on('method')((name: string): string =>
  nameOf('Bulkhead', name),
) as unknown as ((name: string) => AsyncMethodDecorator) & Annotation<string, 'method'>

/** Limits how often the method starts, with the rate limiter of that name defined by the `Resilience()` feature. */
export const RateLimiter = createAnnotation.on('method')((name: string): string =>
  nameOf('RateLimiter', name),
) as unknown as ((name: string) => AsyncMethodDecorator) & Annotation<string, 'method'>

/**
 * Answers a failed call with another method of the same class, called with the error first and then the original
 * arguments: `@Fallback('cachedStock')` on `stock(id)` calls `cachedStock(error, id)`.
 *
 * It wraps every other resilience annotation on the method, and never runs once the caller's signal has aborted.
 */
export const Fallback = createAnnotation.on('method')(
  (method: string | symbol, options?: FallbackAnnotationOptions): FallbackAnnotation => {
    if ((typeof method !== 'string' || method.length === 0) && typeof method !== 'symbol') {
      throw new ErrInvalidOption(
        errMessage(
          `Cannot apply @Fallback: the method must be a non-empty string or a symbol, got ${typeof method === 'string' ? '""' : described(method)}`,
        )
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    return { method, fallbackOn: options?.fallbackOn }
  },
) as unknown as (<K extends string | symbol>(method: K, options?: FallbackAnnotationOptions) => FallbackDecorator<K>) &
  Annotation<FallbackAnnotation, 'method'>

// Every annotation the aspect weaves, in no particular order, with the decorator name a message gives it.
export const ANNOTATIONS: ReadonlyMap<Annotation<unknown, 'method'>, string> = new Map<
  Annotation<unknown, 'method'>,
  string
>([
  [Retry, 'Retry'],
  [CircuitBreaker, 'CircuitBreaker'],
  [TimeLimiter, 'TimeLimiter'],
  [Bulkhead, 'Bulkhead'],
  [RateLimiter, 'RateLimiter'],
  [Fallback, 'Fallback'],
])
