import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

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
  readonly timeout: Duration

  constructor(timeout: Duration) {
    super(
      errMessage(`The call exceeded ${timeout}ms`).reference('@caffeinejs/bff', ErrBFFTimeout).build(),
      'ERR_BFF_TIMEOUT',
    )
    this.timeout = timeout
  }
}

/** `timeout` was given a duration that is not finite and greater than zero. */
export class ErrBFFInvalidTimeout extends ErrBFF {
  constructor(limit: Duration) {
    super(
      errMessage(`Cannot set a timeout of ${formatDuration(limit)}: a timeout must be a positive duration`)
        .reference('@caffeinejs/bff', ErrBFFInvalidTimeout)
        .build(),
      'ERR_BFF_INVALID_TIMEOUT',
    )
  }
}
