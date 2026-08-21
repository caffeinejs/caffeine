import { describe, expect, it } from 'vitest'
import { materialize, readByPath } from '../materializer.js'
import type { ConfigEntry, ConfigSnapshot } from '../types.js'

function makeSnapshot(data: Record<string, unknown>, origin = 'test'): ConfigSnapshot {
  const values = new Map<string, ConfigEntry>(
    Object.entries(data).map(([k, v]) => [k, { key: k, value: v as never, origin }]),
  )
  return { sources: [], values }
}

describe('materialize', () => {
  it('converts dot-key flat map to nested object', () => {
    const result = materialize(makeSnapshot({ 'db.host': 'localhost', 'db.port': 5432 }))
    expect(result).toEqual({ db: { host: 'localhost', port: 5432 } })
  })

  it('handles deeply nested keys', () => {
    const result = materialize(makeSnapshot({ 'a.b.c.d': 'deep' }))
    expect(result).toEqual({ a: { b: { c: { d: 'deep' } } } })
  })

  it('reassembles indexed keys into a real Array', () => {
    const result = materialize(makeSnapshot({ 'tags.0': 'a', 'tags.1': 'b', 'tags.2': 'c' }))
    expect(Array.isArray(result.tags)).toBe(true)
    expect(result.tags).toEqual(['a', 'b', 'c'])
  })

  it('preserves empty-array leaf sentinels', () => {
    const result = materialize(makeSnapshot({ tags: [] }))
    expect(Array.isArray(result.tags)).toBe(true)
    expect(result.tags).toEqual([])
  })

  it('reassembles nested object array elements', () => {
    const result = materialize(makeSnapshot({ 'items.0.host': 'h', 'items.0.port': 1, 'items.1.host': 'i' }))
    expect(Array.isArray(result.items)).toBe(true)
    expect(result.items).toEqual([{ host: 'h', port: 1 }, { host: 'i' }])
  })

  it('builds a dense array for sparse indices', () => {
    const result = materialize(makeSnapshot({ 'tags.0': 'a', 'tags.2': 'c' }))
    expect(Array.isArray(result.tags)).toBe(true)
    expect(result.tags).toHaveLength(3)
    expect((result.tags as unknown[])[0]).toBe('a')
    expect((result.tags as unknown[])[1]).toBeUndefined()
    expect((result.tags as unknown[])[2]).toBe('c')
  })

  it('keeps a whole-array leaf when no indexed children exist', () => {
    const result = materialize(makeSnapshot({ tags: ['a', 'b', 'c'] }))
    expect(Array.isArray(result.tags)).toBe(true)
    expect(result.tags).toEqual(['a', 'b', 'c'])
  })

  it('lets indexed children win over a whole-array leaf at the same path', () => {
    const leafFirst = materialize(makeSnapshot({
      tags: ['old'],
      'tags.0': 'a',
      'tags.1': 'b',
    }))
    expect(Array.isArray(leafFirst.tags)).toBe(true)
    expect(leafFirst.tags).toEqual(['a', 'b'])

    // Whole-array leaf arriving after indexed keys must not overwrite them.
    const indexFirst = materialize(makeSnapshot({
      'tags.0': 'a',
      'tags.1': 'b',
      tags: ['old'],
    }))
    expect(Array.isArray(indexFirst.tags)).toBe(true)
    expect(indexFirst.tags).toEqual(['a', 'b'])
  })

  it('promotes objects whose keys are all unsigned integers', () => {
    const result = materialize(makeSnapshot({ 'map.0': 'x', 'map.1': 'y' }))
    expect(Array.isArray(result.map)).toBe(true)
    expect(result.map).toEqual(['x', 'y'])
  })

  it('does not promote objects with mixed keys', () => {
    const result = materialize(makeSnapshot({ 'map.0': 'x', 'map.name': 'y' }))
    expect(Array.isArray(result.map)).toBe(false)
    expect(result.map).toEqual({ 0: 'x', name: 'y' })
  })

  it('handles null values', () => {
    const result = materialize(makeSnapshot({ key: null }))
    expect(result).toEqual({ key: null })
  })

  it('handles boolean values', () => {
    const result = materialize(makeSnapshot({ debug: false }))
    expect(result).toEqual({ debug: false })
  })

  it('handles escaped dots in key segments', () => {
    const result = materialize(makeSnapshot({ 'map.key\\.with\\.dots': 'value' }))
    expect(result).toEqual({ map: { 'key.with.dots': 'value' } })
  })

  it('merges sibling keys into same parent object', () => {
    const result = materialize(makeSnapshot({ 'http.host': '0.0.0.0', 'http.port': 8080 }))
    expect(result).toEqual({ http: { host: '0.0.0.0', port: 8080 } })
  })

  it('returns empty object for empty snapshot', () => {
    expect(materialize(makeSnapshot({}))).toEqual({})
  })
})

describe('readByPath', () => {
  it('reads nested value by dot path', () => {
    expect(readByPath({ db: { host: 'localhost' } }, 'db.host')).toBe('localhost')
  })

  it('returns undefined for missing path', () => {
    expect(readByPath({ a: 1 }, 'a.b.c')).toBeUndefined()
  })

  it('reads root-level value', () => {
    expect(readByPath({ key: 42 }, 'key')).toBe(42)
  })

  it('handles escaped dots', () => {
    const obj = { map: { 'key.with.dots': 'val' } }
    expect(readByPath(obj, 'map.key\\.with\\.dots')).toBe('val')
  })

  it('indexes into materialized arrays', () => {
    expect(readByPath({ tags: ['a', 'b'] }, 'tags.0')).toBe('a')
    expect(readByPath({ tags: ['a', 'b'] }, 'tags.1')).toBe('b')
  })
})
