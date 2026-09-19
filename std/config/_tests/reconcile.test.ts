import { describe, expect, it } from 'vitest'

import { reconcile } from '../reconcile.js'

// Identity is how the store tells what changed: the live object skips an unchanged subtree with one comparison, and a
// view whose selection kept its identity is not notified. These tests pin that contract.
describe('reconcile', () => {
  it('returns previous itself when the content is equal', () => {
    const previous = { a: { b: [1, 2], c: 'x' }, d: null }
    const changed: string[] = []

    expect(reconcile(previous, { a: { b: [1, 2], c: 'x' }, d: null }, changed)).toBe(previous)
    expect(changed).toEqual([])
  })

  it('makes new objects only along the changed path', () => {
    const previous = { server: { host: 'h', port: 1 }, db: { url: 'u' } }
    const changed: string[] = []

    const next = reconcile(previous, { server: { host: 'h', port: 2 }, db: { url: 'u' } }, changed)

    expect(next).not.toBe(previous)
    expect(next.server).not.toBe(previous.server)
    expect(next.db).toBe(previous.db)
    expect(next).toEqual({ server: { host: 'h', port: 2 }, db: { url: 'u' } })
    expect(changed).toEqual(['server.port'])
  })

  it('reports keys added and keys removed', () => {
    const changed: string[] = []

    reconcile({ a: 1, gone: { x: 1 } }, { a: 1, added: 2 }, changed)

    expect(changed.sort()).toEqual(['added', 'gone'])
  })

  it('reports an array once, at its own path', () => {
    const previous = { tags: ['a', 'b'] }
    const changed: string[] = []

    const next = reconcile(previous, { tags: ['a', 'c', 'd'] }, changed)

    expect(changed).toEqual(['tags'])
    expect(next.tags).toEqual(['a', 'c', 'd'])
  })

  it('keeps an equal array, objects inside it included', () => {
    const previous = { servers: [{ host: 'h' }] }

    expect(reconcile(previous, { servers: [{ host: 'h' }] })).toBe(previous)
  })

  it('reports a change of type', () => {
    const changed: string[] = []

    reconcile({ a: { b: 1 }, c: [1], d: 1 }, { a: 'x', c: { 0: 1 }, d: '1' }, changed)

    expect(changed.sort()).toEqual(['a', 'c', 'd'])
  })

  // Neither a Date nor anything else that is not configuration data has a content equality worth trusting.
  it('compares what is not a plain object or an array by identity', () => {
    const at = new Date(0)
    const changed: string[] = []

    expect(reconcile({ at }, { at })).toEqual({ at })
    reconcile({ at }, { at: new Date(0) }, changed)
    expect(changed).toEqual(['at'])
  })

  it('does not copy __proto__, constructor or prototype', () => {
    const hostile = JSON.parse('{"a":1,"__proto__":{"polluted":"yes"}}') as Record<string, unknown>

    const next = reconcile({ a: 2 }, hostile)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(next)).toEqual(['a'])
  })

  it('works without a changed list', () => {
    const previous = { a: 1 }
    expect(reconcile(previous, { a: 1 })).toBe(previous)
    expect(reconcile(previous, { a: 2 })).toEqual({ a: 2 })
  })
})
