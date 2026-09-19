import { describe, expect, it } from 'vitest'

import {
  countLeaves,
  freezeCopy,
  freezeDeep,
  isForbiddenKey,
  isIndex,
  isPlainObject,
  readPath,
  splitKey,
  toParts,
} from '../tree.js'
import { hasFastProperties } from './v8.testkit.js'

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

describe('freezeCopy', () => {
  it('returns frozen copies of the objects and arrays not frozen yet, and leaves the input alone', () => {
    const input = { a: { b: [{ c: 1 }] } }

    const tree = freezeCopy(input)

    expect(tree).toEqual(input)
    expect(tree).not.toBe(input)
    expect(tree.a).not.toBe(input.a)
    expect(tree.a.b).not.toBe(input.a.b)
    expect(tree.a.b[0]).not.toBe(input.a.b[0])
    expect([tree, tree.a, tree.a.b, tree.a.b[0]].every(node => Object.isFrozen(node))).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
  })

  // A reconciled tree shares the frozen subtrees of the previous snapshot. Copying them would cost the whole tree on
  // every reload and would break the identity that tells a reader nothing changed there.
  it('returns a frozen subtree as it is', () => {
    const shared = Object.freeze({ inner: {} })

    const tree = freezeCopy({ shared })

    expect(tree.shared).toBe(shared)
    expect(Object.isFrozen(shared.inner)).toBe(false)
  })

  it('freezes any other object in place', () => {
    const date = new Date(0)

    const tree = freezeCopy({ date })

    expect(tree.date).toBe(date)
    expect(Object.isFrozen(date)).toBe(true)
  })

  it('never copies __proto__, constructor or prototype', () => {
    const hostile = JSON.parse('{"a":1,"__proto__":{"polluted":"yes"},"constructor":2}') as object

    const tree = freezeCopy(hostile)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(tree)).toEqual(['a'])
  })

  // V8 keeps an object it deleted a key from in dictionary mode, where every read is a hash lookup. Validation
  // deletes each key a schema does not declare, and the copy is what puts such a node back in fast mode.
  it('gives back a node that had a key deleted in fast mode', () => {
    const node: Record<string, number> = { a: 1, b: 2, c: 3 }
    delete node.a
    expect(hasFastProperties(node)).toBe(false)

    const tree = freezeCopy({ node })

    expect(tree.node).toEqual({ b: 2, c: 3 })
    expect(hasFastProperties(tree.node)).toBe(true)
  })
})

describe('toParts', () => {
  it('splits a dotted path and passes an array through', () => {
    expect(toParts('db.host')).toEqual(['db', 'host'])
    expect(toParts(['a.b', 'c'])).toEqual(['a.b', 'c'])
  })

  // One spelling of a path means one path, whether a flat source reads it or a caller asks about it.
  it('splits the bracket form as a flat source does', () => {
    expect(toParts('servers[0].host')).toEqual(splitKey('servers[0].host'))
    expect(toParts('servers[0].host')).toEqual(['servers', '0', 'host'])
  })

  it('reads the empty path as the root', () => {
    expect(toParts('')).toEqual([])
  })
})

describe('splitKey', () => {
  it('splits on dots and brackets', () => {
    expect(splitKey('a.b')).toEqual(['a', 'b'])
    expect(splitKey('servers[0].host')).toEqual(['servers', '0', 'host'])
    expect(splitKey('m[1][2]')).toEqual(['m', '1', '2'])
    expect(splitKey('[0]')).toEqual(['0'])
  })

  it('leaves a bracket that is not an index alone', () => {
    expect(splitKey('a[x]')).toEqual(['a[x]'])
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
