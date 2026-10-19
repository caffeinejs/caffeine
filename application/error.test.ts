import { describe, expect, it } from 'vitest'

import { ErrCaffeine } from './error.js'

class ErrThing extends ErrCaffeine {
  constructor(message: string, cause?: unknown) {
    super(message, 'ERR_THING', cause)
  }
}

describe('ErrCaffeine', () => {
  it('names itself after the most-derived class and carries the code and the cause', () => {
    const cause = new Error('underneath')
    const err = new ErrThing('Cannot do X: reason', cause)

    expect(err.name).toBe('ErrThing')
    expect(err.code).toBe('ERR_THING')
    expect(err.cause).toBe(cause)
  })

  it('leaves the message as given, so a subclass owns all of it, solutions included', () => {
    // A base that formatted the message too would print a second solutions block under the one a subclass built.
    const message = 'Cannot do X: reason\nPossible Solutions:\n  - Do A'

    expect(new ErrThing(message).message).toBe(message)
  })
})
