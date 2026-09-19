import { describe, expect, it } from 'vitest'

import { mergeLayers } from '../merge.js'
import { freezeDeep } from '../tree.js'
import type { ConfigLayer, ConfigObject } from '../types.js'

function layer(name: string, data: Record<string, unknown>): ConfigLayer {
  return { name, data: freezeDeep(data) as ConfigObject }
}

function merged(...data: Record<string, unknown>[]): Record<string, unknown> {
  return mergeLayers(data.map((d, i) => layer(`layer${i}`, d)))
}

describe('mergeLayers', () => {
  it('lets a later layer win a conflicting key', () => {
    expect(merged({ port: 3000 }, { port: 8080 })).toEqual({ port: 8080 })
  })

  it('merges siblings from different layers into one object', () => {
    expect(merged({ server: { host: 'code-host', port: 1 } }, { server: { port: 8080 } })).toEqual({
      server: { host: 'code-host', port: 8080 },
    })
  })

  it('lets null replace a value, because null is a value', () => {
    expect(merged({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })

  it('skips undefined, which says nothing', () => {
    expect(merged({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
  })

  it('replaces an object with a scalar and a scalar with an object', () => {
    expect(merged({ a: { b: 1 } }, { a: 'x' })).toEqual({ a: 'x' })
    expect(merged({ a: 'x' }, { a: { b: 1 } })).toEqual({ a: { b: 1 } })
  })

  it('returns an empty tree for no layers', () => {
    expect(mergeLayers([])).toEqual({})
  })

  // The merged tree is frozen after validation. Sharing an object with a frozen layer would make that impossible
  // to do safely, and mutating a layer would change what the next reload merges.
  it('owns every object it returns and leaves the layers untouched', () => {
    const base = layer('base', { server: { host: 'h' } })
    const result = mergeLayers([base, layer('env', { server: { port: 1 } })]) as Record<string, unknown>

    expect(result.server).not.toBe(base.data.server)
    expect(base.data).toEqual({ server: { host: 'h' } })
    expect(Object.isFrozen(result)).toBe(false)
  })

  // A `__proto__` key from a parsed file is an own property; assigning it would change every object's prototype.
  it('never assigns __proto__, constructor or prototype', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"a":{"prototype":1,"b":2}}',
    ) as Record<string, unknown>

    const result = merged(hostile)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.keys(result)).toEqual(['a'])
    expect(result.a).toEqual({ b: 2 })
  })
})

/**
 * Arrays are replaced, never complemented. A later layer that names a list owns it whole, so a list can be
 * shortened or cleared from the environment, and the old tail never survives.
 */
describe('array merging across layers', () => {
  it('replaces the whole list from the latest layer that mentions it', () => {
    expect(merged({ tags: ['a', 'b', 'c'] }, { tags: ['x', 'y'] }).tags).toEqual(['x', 'y'])
  })

  it('lets a later layer clear a list entirely', () => {
    expect(merged({ tags: ['a', 'b', 'c'] }, { tags: [] }).tags).toEqual([])
  })

  it('uses an earlier layer in full when no later layer mentions the path', () => {
    expect(merged({ tags: ['a', 'b', 'c'] }, { other: 1 }).tags).toEqual(['a', 'b', 'c'])
  })

  it('replaces a nested array through its outermost list', () => {
    expect(merged({ items: [{ hosts: ['a', 'b'] }, { hosts: ['c'] }] }, { items: [{ hosts: ['z'] }] }).items).toEqual([
      { hosts: ['z'] },
    ])
  })

  it('leaves scalars alone', () => {
    expect(merged({ tags: ['a'], port: 3000, host: 'h' }, { tags: ['x'], port: 8080 })).toEqual({
      tags: ['x'],
      port: 8080,
      host: 'h',
    })
  })

  it('accepts a single-element list from a later layer', () => {
    expect(merged({ tags: ['a', 'b'] }, { tags: ['only'] }).tags).toEqual(['only'])
  })

  // What a text source produces: `TAGS=x,y` is one value at `tags`. Splitting it is the schema's job.
  it('lets a later layer replace a whole list with one scalar', () => {
    expect(merged({ tags: ['a', 'b', 'c'] }, { tags: 'x,y' }).tags).toBe('x,y')
  })

  it('replaces an array whose parent key holds a literal dot', () => {
    expect(merged({ 'a.b': ['a', 'b', 'c'] }, { 'a.b': ['x', 'y'] })['a.b']).toEqual(['x', 'y'])
  })
})
