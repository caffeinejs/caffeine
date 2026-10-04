import { describe, expect, it } from 'vitest'

import { reconcile } from '../reconcile.js'
import { freezeCopy } from '../tree.js'
import { hasFastProperties } from './v8.testkit.js'

function changedPaths(previous: unknown, next: unknown): string[] {
  const changed: string[] = []
  reconcile(previous, next, changed)
  return changed
}

// The paths are what a reload reports as changed, to listeners and in its log line, and an empty list is how the
// store knows nothing did, so it keeps the snapshot and the revision it has.
describe('reconcile: the changed paths', () => {
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
    expect(Object.keys(reconcile({ a: 2 }, hostile, []))).toEqual(['a'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

// The tree is the next snapshot. A subtree a reload did not change is the one the previous snapshot held, so a reader
// tells by identity what was left alone, and a reload that changed one value does not copy the whole tree.
describe('reconcile: the next snapshot', () => {
  it('is previous itself when the content is equal', () => {
    const previous = freezeCopy({ a: { b: [1, 2], c: 'x' }, d: null })

    expect(reconcile(previous, { a: { b: [1, 2], c: 'x' }, d: null }, [])).toBe(previous)
  })

  it('makes new objects only along the changed path, and keeps every other subtree', () => {
    const previous = freezeCopy({ server: { host: 'h', port: 1 }, db: { url: 'u' }, tags: ['a'] })
    const input = { server: { host: 'h', port: 2 }, db: { url: 'u' }, tags: ['a'] }

    const next = reconcile(previous, input, [])

    expect(next).toEqual(input)
    expect(next).not.toBe(previous)
    expect(next.server).not.toBe(previous.server)
    expect(next.db).toBe(previous.db)
    expect(next.tags).toBe(previous.tags)
  })

  // What validation hands over had the keys a schema does not declare deleted, so V8 holds it in dictionary mode.
  it('builds what changed or appeared as frozen copies in fast mode, and leaves the input alone', () => {
    const server: Record<string, unknown> = { dropped: true, host: 'h', port: 2 }
    delete server.dropped
    const db = { pool: { max: 1 } }
    const previous: Record<string, any> = freezeCopy({ server: { host: 'h', port: 1 } })

    const next = reconcile(previous, { server, db }, [])

    expect(next.server).not.toBe(server)
    expect(next.db).not.toBe(db)
    expect([next, next.server, next.db, next.db.pool].every(node => Object.isFrozen(node))).toBe(true)
    expect(hasFastProperties(next.server)).toBe(true)
    expect(Object.isFrozen(server) || Object.isFrozen(db)).toBe(false)
  })
})
