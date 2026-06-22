import { describe, it, expect } from 'vitest'
import { DiCafError } from '../errors.js'

describe('Errors', function () {
  it('should init error with provided code', function () {
    const err = new DiCafError('msg', 'ERR_TEST')

    expect(err.message)
      .toEqual('msg')
    expect(err.code)
      .toEqual('ERR_TEST')
  })
})
