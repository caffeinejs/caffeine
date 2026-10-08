export class ErrCaffeine extends Error {
  readonly code: string

  constructor(
    message: string,
    code: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    // The most-derived class name, so a subclass never has to repeat `this.name = 'ErrX'`.
    this.name = new.target.name
    this.code = code
  }
}
