import { describe, expect, it } from 'vitest'

import { buildTree, expandKeys, splitKey } from '../merge.js'
import type { ConfigValue } from '../types.js'

describe('expandKeys', () => {
  // A value that does not survive the trip is a value the application never receives.
  it.each([
    ['nested objects', { server: { host: 'localhost', port: 8080 } }],
    ['arrays of scalars', { tags: ['a', 'b', 'c'] }],
    [
      'arrays of objects',
      {
        items: [
          { id: 1, hosts: ['a'] },
          { id: 2, hosts: [] },
        ],
      },
    ],
    ['an empty array', { tags: [] }],
    ['null and false, which are values rather than absences', { a: null, b: false, c: 0 }],
  ])('keeps %s as they are', (_name, value) => {
    expect(expandKeys(value as Record<string, ConfigValue>)).toEqual(value)
  })

  // What lets a format with no nesting of its own, INI or a properties file, describe a tree.
  it('reads a dotted key as a path', () => {
    expect(expandKeys({ 'db.host': 'x' })).toEqual({ db: { host: 'x' } })
    expect(expandKeys({ 'db.host': 'x' })).toEqual(expandKeys({ db: { host: 'x' } }))
  })

  it('expands dotted keys at any depth', () => {
    expect(expandKeys({ db: { 'pool.max': 10 } })).toEqual({ db: { pool: { max: 10 } } })
  })

  it('handles deeply nested keys', () => {
    expect(expandKeys({ 'a.b.c.d': 'deep' })).toEqual({ a: { b: { c: { d: 'deep' } } } })
  })

  it('merges sibling keys into one parent', () => {
    expect(expandKeys({ 'http.host': '0.0.0.0', 'http.port': 8080 })).toEqual({ http: { host: '0.0.0.0', port: 8080 } })
  })

  it('builds an array from indexed keys', () => {
    const tree = expandKeys({ 'tags.0': 'a', 'tags.1': 'b', 'tags.2': 'c' })

    expect(Array.isArray(tree.tags)).toBe(true)
    expect(tree.tags).toEqual(['a', 'b', 'c'])
  })

  it('reads the bracket form a config server uses', () => {
    expect(expandKeys({ 'servers[0].host': 'h', 'servers[0].port': 1, 'servers[1].host': 'i' })).toEqual({
      servers: [{ host: 'h', port: 1 }, { host: 'i' }],
    })
    expect(expandKeys({ 'matrix[0][1]': 'x', 'matrix[0][0]': 'w' })).toEqual({ matrix: [['w', 'x']] })
  })

  it('keeps an object with mixed keys an object', () => {
    const tree = expandKeys({ 'map.0': 'x', 'map.name': 'y' })

    expect(Array.isArray(tree.map)).toBe(false)
    expect(tree.map).toEqual({ 0: 'x', name: 'y' })
  })

  it('keeps the root an object even when every key is an index', () => {
    const tree = expandKeys({ 0: 'a', 1: 'b' })

    expect(Array.isArray(tree)).toBe(false)
    expect(tree).toEqual({ 0: 'a', 1: 'b' })
  })

  it('returns an empty tree for empty input', () => {
    expect(expandKeys({})).toEqual({})
  })

  // A numeric key is data as often as it is a position: a status code, a port. A config server serving
  // `messages.404` must not fail to load, so only 0 to n - 1 reads as a list, and a schema expecting a list still
  // refuses anything else when it validates.
  it('keeps numeric keys that are not 0 to n - 1 as the keys of an object', () => {
    expect(expandKeys({ 'messages.404': 'Not found', 'messages.500': 'Oops' })).toEqual({
      messages: { 404: 'Not found', 500: 'Oops' },
    })
    expect(expandKeys({ 'tags.1': 'z' })).toEqual({ tags: { 1: 'z' } })
    expect(expandKeys({ 'tags.0': 'a', 'tags.2': 'c' })).toEqual({ tags: { 0: 'a', 2: 'c' } })
  })

  it('builds an array from indices in any order', () => {
    expect(expandKeys({ 'tags.1': 'b', 'tags.0': 'a' })).toEqual({ tags: ['a', 'b'] })
  })

  // `TAGS=a` beside `TAGS__0=b` says two different things. Neither may win silently.
  it('rejects a path set both as a value and as a parent', () => {
    expect(() => expandKeys({ tags: 'a', 'tags.0': 'b' }, 'env')).toThrow(
      expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_KEY_CONFLICT' }),
    )
    expect(() => expandKeys({ 'tags.0': 'b', tags: 'a' }, 'env')).toThrow(
      /"tags" is set both as a value and as a parent/,
    )
    expect(() => expandKeys({ 'db.host': 'x', 'db.host.name': 'y' })).toThrow(/"db.host"/)
  })

  it('skips any path through __proto__, constructor or prototype', () => {
    const tree = expandKeys({ '__proto__.polluted': 'yes', 'a.constructor.x': 1, 'a.prototype': 1, 'a.b': 2 })

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(tree).toEqual({ a: { b: 2 } })
  })
})

describe('buildTree', () => {
  it('lets a later entry for the same path win', () => {
    expect(
      buildTree([
        [['a'], '1'],
        [['a'], '2'],
      ]),
    ).toEqual({ a: '2' })
  })

  it('takes a key holding a dot literally when it arrives pre-split', () => {
    expect(buildTree([[['a.b', 'c'], 1]])).toEqual({ 'a.b': { c: 1 } })
  })

  it('names the source in an error', () => {
    expect(() =>
      buildTree(
        [
          [['tags'], 'a'],
          [['tags', '0'], 'b'],
        ],
        'env:APP_',
      ),
    ).toThrow(/from "env:APP_"/)
  })

  // The parent wins whichever came first, so the tree does not depend on the order the entries arrive in, which for
  // the environment is whatever order the process holds its variables in.
  it('drops a value whose path is also a parent, and reports it, when given somewhere to report it', () => {
    const value: [readonly string[], ConfigValue] = [['otel', 'resource'], 'x']
    const parent: [readonly string[], ConfigValue] = [['otel', 'resource', 'attributes'], 'y']

    for (const entries of [
      [value, parent],
      [parent, value],
    ]) {
      const dropped: string[] = []

      expect(buildTree(entries, 'env', path => dropped.push(path.join('.')))).toEqual({
        otel: { resource: { attributes: 'y' } },
      })
      expect(dropped).toEqual(['otel.resource'])
    }
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
