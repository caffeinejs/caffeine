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
