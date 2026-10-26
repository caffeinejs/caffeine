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
 * An option or argument was invalid. Factories, `compose()` and `runWith()` throw it synchronously; a call rejects
 * with it when a delay computed at call time is not a finite number.
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
 * Retry never retries a refusal, whatever its `retryOn` says, and a circuit breaker never records one.
 */
export class ErrCallRefused extends ErrResilience {
  readonly retryAfter: Duration | undefined

  constructor(message: string, code: string, retryAfter: Duration | undefined) {
    super(message, code)
    this.name = 'ErrCallRefused'
    this.retryAfter = retryAfter
  }
}

const errorClass = Error as { stackTraceLimit?: number }

// Refusals come in bulk while a dependency is down, and capturing a stack costs several times the rest of a refusal.
// The limit is process-wide, so it is restored in a `finally` before anything else can throw:
// `const limit = suppressStacks(); try { return new ErrX(...) } finally { restoreStacks(limit) }`.
export function suppressStacks(): number | undefined {
  const limit = errorClass.stackTraceLimit
  errorClass.stackTraceLimit = 0
  return limit
}

export function restoreStacks(limit: number | undefined): void {
  errorClass.stackTraceLimit = limit
}

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
