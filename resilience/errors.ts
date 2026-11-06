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
 * A policy refused the call; the operation did not run. `retryAfter` is how long until the policy would let a call
 * through again, when it knows.
 *
 * Retry never retries a refusal, whatever its `retryOn` says, and a circuit breaker never records one. A retry whose
 * earlier attempt reached the operation never rejects with one: a refusal that ends it hands back that attempt's
 * outcome, so a caller that receives a refusal knows no attempt ran.
 *
 * A built-in refusal carries no stack trace unless its policy was created with `captureStackTrace: true`: it is built
 * without running its constructor, so `instanceof` and its fields work, but `Error.isError()` answers `false`.
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
 * What a resilience error means to a transport answering a client: `unavailable`, a policy refused the call and it
 * never ran, or `timeout`, a time limit passed and the outcome is unknown. A transport maps it to its own status,
 * such as HTTP 503 and 504, or gRPC `UNAVAILABLE` and `DEADLINE_EXCEEDED`.
 */
export interface ResilienceFailure {
  readonly kind: 'unavailable' | 'timeout'
  /** The error's `code`, such as `ERR_CALL_NOT_PERMITTED`. */
  readonly code: string
  /** How long until the policy lets a call through again, when it knows. */
  readonly retryAfter: Duration | undefined
}

/** Classifies a refusal or a time limit for a transport; any other error, whatever it is, is `undefined`. */
export function failureOf(error: unknown): ResilienceFailure | undefined {
  if (error instanceof ErrCallRefused) {
    return { kind: 'unavailable', code: error.code, retryAfter: error.retryAfter }
  }
  // Read by its code: the time limiter is a subpath of its own, which the root never imports.
  if (error instanceof ErrResilience && error.code === 'ERR_TIME_LIMIT_EXCEEDED') {
    return { kind: 'timeout', code: error.code, retryAfter: undefined }
  }
  return undefined
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
