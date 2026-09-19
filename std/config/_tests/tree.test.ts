import { describe, expect, it } from 'vitest'

import { countLeaves, freezeDeep, isForbiddenKey, isIndex, isPlainObject, readPath, toParts } from '../tree.js'

describe('isForbiddenKey', () => {
  // Assigning any of these on a plain object can reach a prototype instead of creating a property, which is how a
  // configuration file could change every object in the process.
  it.each(['__proto__', 'constructor', 'prototype'])('forbids %s', key => {
    expect(isForbiddenKey(key)).toBe(true)
  })

  it('allows every other key, including names that only resemble them', () => {
    for (const key of ['proto', '__proto', 'constructors', 'toString', 'hasOwnProperty', '']) {
      expect(isForbiddenKey(key)).toBe(false)
    }
  })
})

describe('isPlainObject', () => {
  it('accepts object literals and objects with no prototype', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('rejects arrays, class instances and primitives', () => {
    for (const value of [[], new Date(), new URL('http://x'), new Map(), null, undefined, 'x', 1]) {
      expect(isPlainObject(value)).toBe(false)
    }
  })
})

describe('freezeDeep', () => {
  it('freezes every level', () => {
    const tree = freezeDeep({ a: { b: [{ c: 1 }] } })

    expect(Object.isFrozen(tree)).toBe(true)
    expect(Object.isFrozen(tree.a)).toBe(true)
    expect(Object.isFrozen(tree.a.b)).toBe(true)
    expect(Object.isFrozen(tree.a.b[0])).toBe(true)
  })

  // A reconciled tree reuses frozen subtrees; walking them again on every reload would cost the whole tree.
  it('does not walk into a subtree that is already frozen', () => {
    const shared = Object.freeze({ inner: {} })
    freezeDeep({ shared })

    expect(Object.isFrozen(shared.inner)).toBe(false)
  })
})

describe('toParts', () => {
  it('splits a dotted path and passes an array through', () => {
    expect(toParts('db.host')).toEqual(['db', 'host'])
    expect(toParts(['a.b', 'c'])).toEqual(['a.b', 'c'])
  })

  it('reads the empty path as the root', () => {
    expect(toParts('')).toEqual([])
  })
})

describe('isIndex', () => {
  it('accepts unsigned integers without a leading zero', () => {
    for (const segment of ['0', '1', '10', '999']) {
      expect(isIndex(segment)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    for (const segment of ['01', '-1', '1.5', 'a', '', ' 1']) {
      expect(isIndex(segment)).toBe(false)
    }
  })
})

describe('readPath', () => {
  it('reads a nested value', () => {
    expect(readPath({ db: { host: 'localhost' } }, ['db', 'host'])).toBe('localhost')
  })

  it('reads a root-level value', () => {
    expect(readPath({ key: 42 }, ['key'])).toBe(42)
  })

  it('returns undefined for a missing path', () => {
    expect(readPath({ a: 1 }, ['a', 'b', 'c'])).toBeUndefined()
  })

  it('indexes into arrays', () => {
    expect(readPath({ tags: ['a', 'b'] }, ['tags', '1'])).toBe('b')
    expect(readPath({ tags: ['a', 'b'] }, ['tags', 'length'])).toBeUndefined()
  })

  it('reaches a key holding a literal dot through the array form', () => {
    expect(readPath({ map: { 'key.with.dots': 'val' } }, ['map', 'key.with.dots'])).toBe('val')
  })

  // Only own properties are read, so a path never answers with something inherited.
  it('does not read through a prototype', () => {
    expect(readPath({}, ['constructor'])).toBeUndefined()
    expect(readPath({ a: {} }, ['a', 'toString'])).toBeUndefined()
  })

  it('returns the tree itself for the empty path', () => {
    const tree = { a: 1 }
    expect(readPath(tree, [])).toBe(tree)
  })
})

describe('countLeaves', () => {
  it('counts scalars, and an empty array as one setting', () => {
    expect(countLeaves({ a: 1, b: { c: 'x', d: null }, tags: ['a', 'b'], none: [] })).toBe(6)
  })

  it('counts nothing in an empty object', () => {
    expect(countLeaves({})).toBe(0)
  })
})
