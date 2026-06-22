import { describe, it, expect } from 'vitest'
import { compose, allOf, mapped, optional, provide } from '../injection.js'
import { ErrMissingInjectionKey } from '../errors.js'
import { BuiltInResolvers } from '../injection_resolver.js'

describe('provide()', function () {
  it('returns provider descriptor for a key', function () {
    const k = Symbol.for('test')
    const result = provide(k)
    expect(result)
      .toEqual({ key: k, resolver: BuiltInResolvers.PROVIDER })
  })

  it('includes optional flag when composed with optional()', function () {
    const k = Symbol.for('test')
    const result = optional(provide(k))
    expect(result)
      .toEqual({ key: k, optional: true, resolver: BuiltInResolvers.PROVIDER })
  })

  it('throws ErrMissingInjectionKey when key is null', function () {
    expect(() => provide(null as any))
      .toThrow(ErrMissingInjectionKey)
  })
})

describe('allOf(provide())', function () {
  it('returns provider descriptor with multiple flag for a key', function () {
    const k = Symbol.for('test')
    const result = allOf(provide(k))
    expect(result)
      .toEqual({ key: k, multiple: true, resolver: BuiltInResolvers.PROVIDER })
  })

  it('includes optional flag when composed with optional()', function () {
    const k = Symbol.for('test')
    const result = optional(allOf(provide(k)))
    expect(result)
      .toEqual({ key: k, optional: true, multiple: true, resolver: BuiltInResolvers.PROVIDER })
  })
})

describe('allOf()', function () {
  it('returns default descriptor with multiple flag for a key', function () {
    const k = Symbol.for('test')
    const result = allOf(k)
    expect(result)
      .toEqual({ key: k, multiple: true, resolver: BuiltInResolvers.DEFAULT })
  })

  it('accepts a descriptor and adds multiple flag', function () {
    const k = Symbol.for('test')
    const result = allOf(optional(k))
    expect(result)
      .toEqual({ key: k, optional: true, multiple: true })
  })

  it('preserves existing resolver on descriptor and adds multiple flag', function () {
    const k = Symbol.for('test')
    const result = allOf(mapped(k))
    expect(result)
      .toEqual({ key: k, resolver: BuiltInResolvers.MAP, multiple: true })
  })

  it('throws ErrMissingInjectionKey when descriptor has no valid key', function () {
    expect(() => allOf({ resolver: BuiltInResolvers.DEFAULT }))
      .toThrow(ErrMissingInjectionKey)
  })
})

describe('optional()', function () {
  it('returns descriptor with optional: true for a key', function () {
    const k = Symbol.for('test')
    const result = optional(k)

    expect(result)
      .toEqual({ key: k, optional: true })
  })
})

describe('compose()', function () {
  it('merges flags from two injection functions', function () {
    const k = Symbol.for('test')
    const result = compose(k, optional, allOf)
    expect(result)
      .toEqual({ key: k, optional: true, multiple: true, resolver: BuiltInResolvers.DEFAULT })
  })

  it('merges flags from three injection functions', function () {
    const k = Symbol.for('test')
    const result = compose(k, optional, allOf, mapped)
    expect(result)
      .toEqual({ key: k, optional: true, multiple: true, resolver: BuiltInResolvers.MAP })
  })

  it('applies to different keys independently', function () {
    const k1 = Symbol.for('a')
    const k2 = Symbol.for('b')
    expect(compose(k1, optional, allOf))
      .toEqual({ key: k1, optional: true, multiple: true, resolver: BuiltInResolvers.DEFAULT })
    expect(compose(k2, optional, allOf))
      .toEqual({ key: k2, optional: true, multiple: true, resolver: BuiltInResolvers.DEFAULT })
  })

  it('with a single function behaves like that function', function () {
    const k = Symbol.for('test')
    expect(compose(k, optional))
      .toEqual(optional(k))
  })
})
