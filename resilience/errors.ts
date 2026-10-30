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
 * It is thrown synchronously where the bad value is given: by the factories, `compose()`, `runWith()`, the
 * `Resilience()` builder, a resilience annotation and a `ResilienceRegistry` lookup of an undefined name.
 * `Resilience()` and `ResilienceHTTP()` throw it at `bootstrap()`.
 *
 * A call rejects with it when it cannot run as configured: a delay computed at call time is not a finite number, a
 * predicate such as `retryOn` or `fallbackOn` returns anything but a boolean, `recover()` is handed a handler that is
 * not a function, a strategy hands `next` a context that `runWith()`, `compose()` or `ctx.with()` did not make, or an
 * annotated method names an instance or a fallback method that does not exist.
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
