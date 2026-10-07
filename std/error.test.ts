import { afterEach, describe, expect, it } from 'vitest'

import { ErrCaffeine } from './error.js'
import { CaffeineRuntime } from './platform.js'

class ErrThing extends ErrCaffeine {
  constructor(...solutions: string[]) {
    super('Cannot do X: reason', 'ERR_THING', undefined, ...solutions)
  }
}

describe('ErrCaffeine', () => {
  afterEach(() => {
    CaffeineRuntime.hideErrorSolutions = false
  })

  it('names itself after the most-derived class and carries the code', () => {
    const err = new ErrThing()

    expect(err.name).toBe('ErrThing')
    expect(err.code).toBe('ERR_THING')
    expect(err.message).toBe('Cannot do X: reason')
  })

  it('appends the solutions a subclass hands over', () => {
    expect(new ErrThing('Do A', 'Do B').message).toBe('Cannot do X: reason\nPossible Solutions:\n  - Do A\n  - Do B')
  })

  it('drops the solutions and keeps the message when the runtime hides them', () => {
    CaffeineRuntime.hideErrorSolutions = true

    expect(new ErrThing('Do A').message).toBe('Cannot do X: reason')
  })
})
