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

  it('handles arrays as leaf values', () => {
    const result = materialize(makeSnapshot({ tags: ['a', 'b', 'c'] }))
    expect(result).toEqual({ tags: ['a', 'b', 'c'] })
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
})
