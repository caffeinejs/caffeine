import { describe, it, expect } from 'vitest'
import { DeferredCtor } from '../deferred_ctor.js'
import { isNamedKey, isValidKey, keyStr } from '../key.js'

describe('keyStr()', function () {
  it('should return "(undefined)" when key is undefined', function () {
    expect(keyStr(undefined)).toBe('(undefined)')
  })

  it('should return the class name when key is a constructor', function () {
    class MyService {}
    expect(keyStr(MyService)).toBe('MyService')
  })

  it('should return the string as-is when key is a string', function () {
    expect(keyStr('myToken')).toBe('myToken')
  })

  it('should return the symbol description when key is a symbol', function () {
    const sym = Symbol('mySymbol')
    expect(keyStr(sym)).toBe('Symbol(mySymbol)')
  })

  describe('DeferredCtor branch (lines 38–40)', function () {
    it('should recursively resolve a DeferredCtor wrapping a class constructor', function () {
      class TargetService {}
      const deferred = new DeferredCtor(() => TargetService)
      expect(keyStr(deferred)).toBe('TargetService')
    })

    it('should recursively resolve a DeferredCtor wrapping a string key', function () {
      const deferred = new DeferredCtor(() => 'stringToken')
      expect(keyStr(deferred)).toBe('stringToken')
    })

    it('should recursively resolve a DeferredCtor wrapping a symbol key', function () {
      const sym = Symbol('deferredSym')
      const deferred = new DeferredCtor(() => sym)
      expect(keyStr(deferred)).toBe('Symbol(deferredSym)')
    })

    it('should recursively resolve a nested DeferredCtor', function () {
      class Inner {}
      const inner = new DeferredCtor(() => Inner)
      const outer = new DeferredCtor(() => inner)
      expect(keyStr(outer)).toBe('Inner')
    })
  })
})

describe('isNamedKey()', function () {
  it('should return true for a non-empty string', function () {
    expect(isNamedKey('token')).toBe(true)
  })

  it('should return false for an empty string', function () {
    expect(isNamedKey('')).toBe(false)
  })

  it('should return true for a symbol', function () {
    expect(isNamedKey(Symbol('s'))).toBe(true)
  })

  it('should return false for a number', function () {
    expect(isNamedKey(42)).toBe(false)
  })
})

describe('isValidKey()', function () {
  it('should return false for undefined', function () {
    expect(isValidKey(undefined)).toBe(false)
  })

  it('should return false for null', function () {
    expect(isValidKey(null)).toBe(false)
  })

  it('should return true for a non-empty string', function () {
    expect(isValidKey('token')).toBe(true)
  })

  it('should return false for an empty string', function () {
    expect(isValidKey('')).toBe(false)
  })

  it('should return true for a symbol', function () {
    expect(isValidKey(Symbol('k'))).toBe(true)
  })

  it('should return true for a class constructor', function () {
    class Svc {}
    expect(isValidKey(Svc)).toBe(true)
  })

  it('should return true for a DeferredCtor', function () {
    class Svc {}
    expect(isValidKey(new DeferredCtor(() => Svc))).toBe(true)
  })

  it('should return false for a number', function () {
    expect(isValidKey(42)).toBe(false)
  })
})
