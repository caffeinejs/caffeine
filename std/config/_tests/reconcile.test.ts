import { describe, expect, it } from 'vitest'

import { changedPaths } from '../reconcile.js'

// The paths are what a reload reports as changed, to listeners and in its log line, and an empty list is how the
// store knows nothing did, so it keeps the snapshot and the revision it has.
describe('changedPaths', () => {
  it('reports nothing when the content is equal', () => {
    expect(changedPaths({ a: { b: [1, 2], c: 'x' }, d: null }, { a: { b: [1, 2], c: 'x' }, d: null })).toEqual([])
  })

  it('reports the leaf that changed, not the nodes above it', () => {
    expect(
      changedPaths(
        { server: { host: 'h', port: 1 }, db: { url: 'u' } },
        { server: { host: 'h', port: 2 }, db: { url: 'u' } },
      ),
    ).toEqual(['server.port'])
  })

  it('reports keys added and keys removed', () => {
    expect(changedPaths({ a: 1, gone: { x: 1 } }, { a: 1, added: 2 }).sort()).toEqual(['added', 'gone'])
  })

  it('reports an array once, at its own path', () => {
    expect(changedPaths({ tags: ['a', 'b'] }, { tags: ['a', 'c', 'd'] })).toEqual(['tags'])
  })

  it('reports nothing for an equal array, objects inside it included', () => {
    expect(changedPaths({ servers: [{ host: 'h' }] }, { servers: [{ host: 'h' }] })).toEqual([])
  })

  it('reports a change of type', () => {
    expect(changedPaths({ a: { b: 1 }, c: [1], d: 1 }, { a: 'x', c: { 0: 1 }, d: '1' }).sort()).toEqual(['a', 'c', 'd'])
  })

  // Neither a Date nor anything else that is not configuration data has a content equality worth trusting.
  it('compares what is not a plain object or an array by identity', () => {
    const at = new Date(0)

    expect(changedPaths({ at }, { at })).toEqual([])
    expect(changedPaths({ at }, { at: new Date(0) })).toEqual(['at'])
  })

  it('ignores __proto__, constructor and prototype', () => {
    const hostile = JSON.parse('{"a":1,"__proto__":{"polluted":"yes"}}') as Record<string, unknown>

    expect(changedPaths({ a: 1 }, hostile)).toEqual([])
  })
})
