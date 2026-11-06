import { type Annotation, createAnnotation } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { described, type ErrorMatcher, ErrInvalidOption } from '../errors.js'

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
   * Declares that running the method twice is safe. An HTTP handler routed for a method that is not safe may be
   * retried only when it says so, unless the application allows that method; it deduplicates nothing.
   */
  readonly repeatable?: boolean
}

/** What `@Resilient` takes. */
export type ResilientAnnotationOptions = RetryAnnotationOptions

/** What `@Resilient` stores. */
export interface ResilientAnnotation {
  readonly preset: string | false
  readonly repeatable: boolean
}

/** What `@Retry` stores. */
export interface RetryAnnotation {
  readonly preset: string | false
  readonly repeatable: boolean
}

export interface FallbackAnnotationOptions {
  /**
   * Which errors are handed to the fallback method: a predicate, or a list of error classes. Defaults to every error,
   * a programming error included.
   */
  readonly on?: ErrorMatcher
}

/** What `@Fallback` stores. */
export interface FallbackAnnotation {
  readonly method: string | symbol
  readonly on: ErrorMatcher | undefined
}

// On a class, an annotation reaches every method the class declares or inherits with `async`.
type StageDecorator = AsyncMethodDecorator &
  (<C extends abstract new (...args: never) => unknown>(target: C, context: ClassDecoratorContext<C>) => void)

// `false` takes away what a class-level annotation of the same kind gives one method.
function nameOf(decorator: string, name: unknown): string | false {
  if (name === false) {
    return false
  }
  if (typeof name !== 'string' || name.length === 0) {
    const stage = decorator === 'Resilient' ? '...' : `${decorator[0]!.toLowerCase()}${decorator.slice(1)}({ ... })`
    throw new ErrInvalidOption(
      errMessage(
        `Cannot apply @${decorator}: the preset name must be a non-empty string or false, got ${typeof name === 'string' ? '""' : described(name)}`,
      )
        .solutions(`Name a preset defined with Resilience(r => r.preset('name', p => p.${stage}))`)
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  return name
}

/**
 * Runs the method through every policy the preset of that name defines, in the order of the `Resilience()` feature,
 * whatever order the preset's builder calls were written in.
 *
 * A stage annotation next to it replaces one policy and keeps the rest: `@Resilient('inventory')` with
 * `@TimeLimiter('inventory-export')` runs the retry and the circuit breaker of `inventory`, the same instances every
 * other method of `inventory` uses, with the time limiter of `inventory-export`. `repeatable` is that of the annotation
 * that gives the method its retry, so a method's own `@Retry('orders', { repeatable: false })` stays unrepeatable under
 * a class's `@Resilient('all', { repeatable: true })`.
 *
 * On a class, it reaches every method the class declares or inherits with `async`, except one a `@Fallback` names; a
 * method that returns a promise without `async` is not reached. A method's own annotations win, kind by kind, and
 * `@Resilient(false)` keeps the class's preset off one method.
 */
export const Resilient = createAnnotation.on(
  'class',
  'method',
)((preset: string | false, options?: ResilientAnnotationOptions): ResilientAnnotation => ({
  preset: nameOf('Resilient', preset),
  repeatable: options?.repeatable ?? false,
})) as unknown as ((preset: string | false, options?: ResilientAnnotationOptions) => StageDecorator) &
  Annotation<ResilientAnnotation, 'class' | 'method'>

/**
 * Runs the method again when it fails, with the retry of the preset of that name. `@Retry(false)` runs the method
 * without the retry `@Resilient` or the class would give it.
 *
 * Retrying a method repeats everything it does. On a class, it reaches the methods `@Resilient` on a class reaches.
 */
export const Retry = createAnnotation.on(
  'class',
  'method',
)((preset: string | false, options?: RetryAnnotationOptions): RetryAnnotation => ({
  preset: nameOf('Retry', preset),
  repeatable: options?.repeatable ?? false,
})) as unknown as ((preset: string | false, options?: RetryAnnotationOptions) => StageDecorator) &
  Annotation<RetryAnnotation, 'class' | 'method'>

/**
 * Guards the method with the circuit breaker of the preset of that name; `false` removes the one `@Resilient` or the
 * class would give it. On a class, it reaches the methods `@Resilient` on a class reaches.
 */
export const CircuitBreaker = createAnnotation.on(
  'class',
  'method',
)((preset: string | false): string | false => nameOf('CircuitBreaker', preset)) as unknown as ((
  preset: string | false,
) => StageDecorator) &
  Annotation<string | false, 'class' | 'method'>

/**
 * Bounds how long the method may run, with the time limiter of the preset of that name; `false` removes the one
 * `@Resilient` or the class would give it. On a class, it reaches the methods `@Resilient` on a class reaches.
 */
export const TimeLimiter = createAnnotation.on(
  'class',
  'method',
)((preset: string | false): string | false => nameOf('TimeLimiter', preset)) as unknown as ((
  preset: string | false,
) => StageDecorator) &
  Annotation<string | false, 'class' | 'method'>

/**
 * Limits how many calls of the method run at once, with the bulkhead of the preset of that name; `false` removes the
 * one `@Resilient` or the class would give it. On a class, it reaches the methods `@Resilient` on a class reaches.
 */
export const Bulkhead = createAnnotation.on(
  'class',
  'method',
)((preset: string | false): string | false => nameOf('Bulkhead', preset)) as unknown as ((
  preset: string | false,
) => StageDecorator) &
  Annotation<string | false, 'class' | 'method'>

/**
 * Limits how often the method starts, with the rate limiter of the preset of that name; `false` removes the one
 * `@Resilient` or the class would give it. On a class, it reaches the methods `@Resilient` on a class reaches.
 */
export const RateLimiter = createAnnotation.on(
  'class',
  'method',
)((preset: string | false): string | false => nameOf('RateLimiter', preset)) as unknown as ((
  preset: string | false,
) => StageDecorator) &
  Annotation<string | false, 'class' | 'method'>

/**
 * Answers a failed call with another method of the same class, called with the error first and then the original
 * arguments: `@Fallback('cachedStock')` on `stock(id)` calls `cachedStock(error, id)`.
 *
 * It wraps every other resilience annotation on the method, and never runs once the caller's signal has aborted.
 * Without `on`, it answers every error, a bug such as a `TypeError` included, which then looks like an outage: narrow
 * it with `on`, such as `{ on: [ErrCallRefused] }`. On an entrypoint, such as a controller, it never answers an error
 * the transport calls the client's own, such as a 403 the method throws to refuse a caller, whatever `on` says.
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

    return { method, on: options?.on }
  },
) as unknown as (<K extends string | symbol>(method: K, options?: FallbackAnnotationOptions) => FallbackDecorator<K>) &
  Annotation<FallbackAnnotation, 'method'>

// Every annotation the aspect weaves, in no particular order, with the decorator name a message gives it.
export const ANNOTATIONS: ReadonlyMap<Annotation<unknown, 'method'>, string> = new Map<
  Annotation<unknown, 'method'>,
  string
>([
  [Resilient, 'Resilient'],
  [Retry, 'Retry'],
  [CircuitBreaker, 'CircuitBreaker'],
  [TimeLimiter, 'TimeLimiter'],
  [Bulkhead, 'Bulkhead'],
  [RateLimiter, 'RateLimiter'],
  [Fallback, 'Fallback'],
])
