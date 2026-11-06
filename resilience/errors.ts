import type { Duration } from '@caffeinejs/std/duration'

export class ErrResilience extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrResilience'
    this.code = code
  }
}

/**
 * An option, an argument, a name or an annotation was invalid.
 *
 * It is thrown synchronously where the bad value is given: by the factories, `compose()`, `decorate()`, the
 * `Resilience()` builder, a resilience annotation and a `ResilienceRegistry` lookup of an undefined name.
 * `Resilience()` and `ResilienceHTTP()` throw it at `bootstrap()`.
 *
 * A call rejects with it when it cannot run as configured: a delay computed at call time is not a finite number, a
 * predicate such as `retryOn` or a fallback's `on` returns anything but a boolean, or an annotated method names an
 * instance or a fallback method that does not exist.
 */
export class ErrInvalidOption extends ErrResilience {
  constructor(message: string) {
    super(message, 'ERR_INVALID_OPTION')
    this.name = 'ErrInvalidOption'
  }
}

/**
 * A strategy refused the call; the operation did not run. `retryAfter` is how long until the strategy would let a
 * call through again, when it knows.
 *
 * Retry never retries a refusal, whatever its `retryOn` says, and a circuit breaker never records one. A retry whose
 * earlier attempt reached the operation never rejects with one: a refusal that ends it hands back that attempt's
 * outcome, so a caller that receives a refusal knows no attempt ran.
 */
export class ErrCallRefused extends ErrResilience {
  readonly retryAfter: Duration | undefined

  constructor(message: string, code: string, retryAfter: Duration | undefined) {
    super(message, code)
    this.name = 'ErrCallRefused'
    this.retryAfter = retryAfter
  }
}

/**
 * A refusal built without running its class's constructor, so no stack trace is captured: refusals come in bulk
 * while a dependency is down, and a capture costs several times the rest of a refusal. `fields` are set in order after
 * `message`, as the constructors set them, and `stack` is the first line alone, as an error without frames prints.
 */
export function refusal<E extends ErrCallRefused>(
  cls: abstract new (...args: never) => E,
  message: string,
  fields: { readonly [K in Exclude<keyof E, keyof Error>]: E[K] } & { readonly name: string },
): E {
  const error = Object.create(cls.prototype) as E
  Object.defineProperty(error, 'message', { value: message, writable: true, configurable: true })
  Object.assign(error, fields)
  Object.defineProperty(error, 'stack', { value: `${fields.name}: ${message}`, writable: true, configurable: true })
  return error
}

/** A class of errors, such as `TypeError` or `ErrHTTP`, matched with `instanceof`. */
export type ErrorClass = abstract new (...args: never) => Error

/**
 * Which errors an option applies to: a predicate, which must return a boolean, or a list of error classes, which
 * matches an error that is an instance of any of them.
 */
export type ErrorMatcher = ((error: unknown) => boolean) | readonly ErrorClass[]

// What a predicate returned instead of a boolean, for the error that says so.
export function described(value: unknown): string {
  if (value === undefined || value === null) {
    return String(value)
  }
  if (typeof (value as { then?: unknown }).then === 'function') {
    return 'a promise'
  }

  const type = typeof value
  return type === 'object' ? 'an object' : `a ${type}`
}
