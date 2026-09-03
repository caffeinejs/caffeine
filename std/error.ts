import { CaffeineRuntime } from './runtime.js'

export function solutions(...solutions: string[]) {
  return '\nPossible Solutions:\n  - ' + solutions.join('\n  - ')
}

export class ErrCaffeine extends Error {
  readonly code: string

  constructor(
    message: string,
    code: string,
    override readonly cause?: unknown,
    ...solutions: string[]
  ) {
    super(
      message +
        (solutions.length > 0 && !CaffeineRuntime.hideErrorSolutions
          ? '\nPossible Solutions:\n  - ' + solutions.join('\n  - ')
          : ''),
    )
    // The most-derived class name, so a subclass never has to repeat `this.name = 'ErrX'`.
    this.name = new.target.name
    this.code = code
  }
}
