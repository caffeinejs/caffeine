export class ErrResilience extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrResilience'
    this.code = code
  }
}

/** The circuit breaker states in which a call can be refused. */
export type NotPermittedState = 'open' | 'forced_open' | 'half_open'

const refusals: Record<NotPermittedState, string> = {
  open: 'circuit breaker is open',
  forced_open: 'circuit breaker is forced open',
  half_open: 'circuit breaker is half open and every trial call is in use',
}

/**
 * A circuit breaker refused the call; the operation did not run.
 *
 * `retryAfterMs` is the time left before the breaker lets trial calls through again. It is set only when `state`
 * is `open`: a forced-open breaker stays open until someone resets it, and a half-open one frees a trial slot when
 * a trial call settles.
 */
export class ErrCallNotPermitted extends ErrResilience {
  /** The name of the circuit breaker that refused the call. */
  readonly breaker: string
  readonly state: NotPermittedState
  readonly retryAfterMs: number | undefined

  constructor(breaker: string, state: NotPermittedState, retryAfterMs: number | undefined) {
    super(`Cannot call "${breaker}": ${refusals[state]}`, 'ERR_CALL_NOT_PERMITTED')
    this.name = 'ErrCallNotPermitted'
    this.breaker = breaker
    this.state = state
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Every attempt returned a result the retry was told to retry, and the retry was told to fail rather than hand the
 * last one back. The last result is in `result`.
 */
export class ErrMaxRetriesExceeded extends ErrResilience {
  readonly attempts: number
  readonly result: unknown

  constructor(retry: string, attempts: number, result: unknown) {
    super(`Cannot complete "${retry}": result still retryable after ${attempts} attempts`, 'ERR_MAX_RETRIES_EXCEEDED')
    this.name = 'ErrMaxRetriesExceeded'
    this.attempts = attempts
    this.result = result
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
