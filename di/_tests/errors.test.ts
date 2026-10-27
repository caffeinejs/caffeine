import { describe, it, expect } from 'vitest'

import { CaffeineIoCError, ErrDuplicateBinding } from '../errors.js'

describe('Errors', function () {
  it('should init error with provided code', function () {
    const err = new CaffeineIoCError('msg', 'ERR_TEST')

    expect(err.message).toEqual('msg')
    expect(err.code).toEqual('ERR_TEST')
  })

  // rebind() is for the framework and @caffeinejs/testing: an application told to use it would hide the duplicate.
  it('should point a duplicate binding at a real fix, never at rebind()', function () {
    class Repository {
      readonly kind = 'repository'
    }

    const err = new ErrDuplicateBinding(Repository)

    expect(err.code).toBe('ERR_DUPLICATE_BINDING')
    expect(err.message).not.toMatch(/rebind/i)
    expect(err.message).toContain(
      'Bind each implementation under its own key, share one with .extends() or .names(), and mark the default with .primary()',
    )
  })
})
