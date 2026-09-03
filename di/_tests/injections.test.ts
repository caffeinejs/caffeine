import { describe, it, expect } from 'vitest'

import { ErrMissingInjectionKey } from '../errors.js'
import { $i } from '../injection.js'
import { BuiltInResolvers } from '../injection_resolver.js'
import { token } from '../key.js'

describe('$i.provide()', function () {
  it('returns provider descriptor for a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.provide(k)
    expect(result).toEqual({ key: k, resolver: BuiltInResolvers.PROVIDER })
  })

  it('includes optional flag when composed with $i.optional()', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.optional($i.provide(k))
    expect(result).toEqual({ key: k, optional: true, resolver: BuiltInResolvers.PROVIDER })
  })

  it('throws ErrMissingInjectionKey when key is null', function () {
    expect(() => $i.provide(null as any)).toThrow(ErrMissingInjectionKey)
  })
})

describe('$i.allOf($i.provide())', function () {
  it('returns provider descriptor with multiple flag for a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf($i.provide(k))
    expect(result).toEqual({ key: k, multiple: true, resolver: BuiltInResolvers.PROVIDER })
  })

  it('includes optional flag when composed with $i.optional()', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.optional($i.allOf($i.provide(k)))
    expect(result).toEqual({ key: k, optional: true, multiple: true, resolver: BuiltInResolvers.PROVIDER })
  })
})

describe('$i.allOf()', function () {
  it('returns default descriptor with multiple flag for a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf(k)
    expect(result).toEqual({ key: k, multiple: true, resolver: BuiltInResolvers.DEFAULT })
  })

  it('accepts a descriptor and adds multiple flag', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf($i.optional(k))
    expect(result).toEqual({ key: k, optional: true, multiple: true })
  })

  it('preserves existing resolver on descriptor and adds multiple flag', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf($i.mapped(k))
    expect(result).toEqual({ key: k, resolver: BuiltInResolvers.MAP, multiple: true })
  })

  it('throws ErrMissingInjectionKey when descriptor has no valid key', function () {
    expect(() => $i.allOf({ resolver: BuiltInResolvers.DEFAULT })).toThrow(ErrMissingInjectionKey)
  })
})

describe('$i.optional()', function () {
  it('returns descriptor with optional: true for a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.optional(k)

    expect(result).toEqual({ key: k, optional: true })
  })
})

describe('$i.compose()', function () {
  it('merges flags from two injection functions', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.compose(k, $i.optional, $i.allOf)
    expect(result).toEqual({ key: k, optional: true, multiple: true, resolver: BuiltInResolvers.DEFAULT })
  })

  it('merges flags from three injection functions', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.compose(k, $i.optional, $i.allOf, $i.mapped)
    expect(result).toEqual({ key: k, optional: true, multiple: true, resolver: BuiltInResolvers.MAP })
  })

  it('applies to different keys independently', function () {
    const k1 = token<Record<string, unknown>>(Symbol.for('a'))
    const k2 = token<Record<string, unknown>>(Symbol.for('b'))
    expect($i.compose(k1, $i.optional, $i.allOf)).toEqual({
      key: k1,
      optional: true,
      multiple: true,
      resolver: BuiltInResolvers.DEFAULT,
    })
    expect($i.compose(k2, $i.optional, $i.allOf)).toEqual({
      key: k2,
      optional: true,
      multiple: true,
      resolver: BuiltInResolvers.DEFAULT,
    })
  })

  it('with a single function behaves like that function', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    expect($i.compose(k, $i.optional)).toEqual($i.optional(k))
  })
})
