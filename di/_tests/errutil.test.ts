import { describe, expect, it } from 'vitest'

import { ErrConflictingInjectionStages } from '../errors.js'

describe('error messages', () => {
  it('prints each solution under one bullet', () => {
    // The strings once carried their own dash and rendered as `  - - Keep only one of them`.
    const err = new ErrConflictingInjectionStages(Symbol('first'), Symbol('second'))

    expect(err.message).toBe(
      'Cannot compose injection stages "first" and "second": both decide what the injection resolves to' +
        '\nPossible Solutions:' +
        '\n  - Keep only one of them' +
        '\n  - Stages that transform or wrap, such as ordered and provide, compose with any of them',
    )
  })
})
