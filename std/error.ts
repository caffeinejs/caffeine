import { errMessage } from './framework/err/index.js'
import { CaffeineRuntime } from './platform.js'

export class ErrCaffeine extends Error {
  readonly code: string

  constructor(
    message: string,
    code: string,
    override readonly cause?: unknown,
    ...solutions: string[]
  ) {
    super(
      errMessage(message)
        .solutions(...(CaffeineRuntime.hideErrorSolutions ? [] : solutions))
        .build(),
    )
    // The most-derived class name, so a subclass never has to repeat `this.name = 'ErrX'`.
    this.name = new.target.name
    this.code = code
  }
}
