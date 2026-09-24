import type { Duration } from '@caffeinejs/std'

export class ErrBFF extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/** The call outlived the deadline {@link timeout} was given. */
export class ErrBFFTimeout extends ErrBFF {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`The call exceeded ${timeoutMs}ms`, 'ERR_BFF_TIMEOUT')
    this.timeoutMs = timeoutMs
  }
}

/** `timeout` was given a duration that is not finite and greater than zero. */
export class ErrBFFInvalidTimeout extends ErrBFF {
  constructor(limit: Duration) {
    super(`Cannot set a timeout of ${String(limit)}: a timeout must be a positive duration`, 'ERR_BFF_INVALID_TIMEOUT')
  }
}
