import { CaffeineRuntime } from './runtime.js'

export function solutions(...solutions: string[]) {
  return '\nPossible Solutions:\n  - ' + solutions.join('\n  - ')
}

export class ErrCaffeine extends Error {
  readonly code: string

  constructor(message: string, code: string, override readonly cause?: unknown, ...solutions: string[]) {
    super(message + (solutions && !CaffeineRuntime.hideErrorSolutions ? '\nPossible Solutions:\n  - ' + solutions.join('\n  - ') : ''))
    this.code = code
  }
}
