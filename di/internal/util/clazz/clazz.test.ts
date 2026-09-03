import { describe, it, expect } from 'vitest'

import { isConstructable } from './clazz.js'

describe('isConstructable', function () {
  it('should return true for a class', function () {
    class Foo {}
    expect(isConstructable(Foo)).toBe(true)
  })

  it('should return true for a class with constructor params', function () {
    class Bar {
      constructor(readonly x: number) {}
    }
    expect(isConstructable(Bar)).toBe(true)
  })

  it('should return true for a class expression', function () {
    const Baz = class {}
    expect(isConstructable(Baz)).toBe(true)
  })

  it('should return false for an arrow function', function () {
    const fn = () => {}
    expect(isConstructable(fn)).toBe(false)
  })

  it('should return false for a regular function assigned to a variable', function () {
    const fn = function () {}
    fn.prototype = undefined as any
    expect(isConstructable(fn)).toBe(false)
  })

  it('should return false for null', function () {
    expect(isConstructable(null)).toBe(false)
  })

  it('should return false for undefined', function () {
    expect(isConstructable(undefined)).toBe(false)
  })

  it('should return false for a string', function () {
    expect(isConstructable('hello')).toBe(false)
  })

  it('should return false for a number', function () {
    expect(isConstructable(42)).toBe(false)
  })

  it('should return false for a plain object', function () {
    expect(isConstructable({})).toBe(false)
  })

  it('should return false for an instance of a class', function () {
    class Qux {}
    expect(isConstructable(new Qux())).toBe(false)
  })
})
