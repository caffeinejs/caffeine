import { it, fc } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { isNamedKey, isValidKey, InjectionToken, keyStr } from '../../key.js'

describe('key utilities (property)', function () {
  it.prop([fc.string({ minLength: 1 })])('isNamedKey returns true for non-empty strings', key => {
    expect(isNamedKey(key)).toBe(true)
    expect(isValidKey(key)).toBe(true)
  })

  it('isNamedKey returns false for empty string', function () {
    expect(isNamedKey('')).toBe(false)
    expect(isValidKey('')).toBe(false)
  })

  it.prop([fc.string()])('keyStr of string matches toString', key => {
    expect(keyStr(key)).toBe(key.toString())
  })

  it.prop([fc.constant(undefined)])('keyStr of undefined is (undefined)', key => {
    expect(keyStr(key)).toBe('(undefined)')
  })

  it.prop([fc.func(fc.anything())])('isValidKey returns true for functions', fn => {
    expect(isValidKey(fn)).toBe(true)
    expect(keyStr(fn as unknown as InjectionToken)).toBe((fn as unknown as Function).name)
  })

  it('keyStr uses function name for class constructors', function () {
    class SampleSvc {}

    expect(keyStr(SampleSvc)).toBe('SampleSvc')
  })

  it('keyStr uses toString for symbols', function () {
    const sym = Symbol('named-symbol')

    expect(keyStr(sym)).toBe(sym.toString())
  })

  it('isValidKey returns false for null and undefined', function () {
    expect(isValidKey(null)).toBe(false)
    expect(isValidKey(undefined)).toBe(false)
  })
})
