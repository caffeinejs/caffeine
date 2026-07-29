import { describe, expect, it } from 'vitest'
import { createLiveAccessors } from '../config_accessor.js'

interface AppConfig {
  http: { host: string, port: number }
  db: { url: string, pool: number }
  origin: string
  tags: string[]
}

describe('createLiveAccessors', () => {
  it('returns typed values via getters', () => {
    const data: AppConfig = {
      http: { host: 'localhost', port: 3000 },
      db: { url: 'postgres://localhost', pool: 5 },
      origin: 'test-origin',
      tags: ['a', 'b'],
    }
    const config = createLiveAccessors(() => data)
    expect(config.http.host).toBe('localhost')
    expect(config.http.port).toBe(3000)
    expect(config.db.url).toBe('postgres://localhost')
    expect(config.origin).toBe('test-origin')
  })

  it('Object.keys returns schema field names', () => {
    const data = { http: { host: 'h', port: 80 }, db: { url: 'u', pool: 1 }, origin: 'o', tags: [] }
    const config = createLiveAccessors(() => data)
    expect(Object.keys(config).sort()).toEqual(['db', 'http', 'origin', 'tags'].sort())
  })

  it('JSON.stringify serializes correctly', () => {
    const data = { x: 1, y: { z: 2 } }
    const config = createLiveAccessors(() => data)
    expect(JSON.stringify(config)).toBe(JSON.stringify(data))
  })

  it('arrays are frozen snapshots', () => {
    const data = { tags: ['a', 'b'] }
    const config = createLiveAccessors(() => data)
    const tags = config.tags as string[]
    expect(Object.isFrozen(tags)).toBe(true)
    expect([...tags]).toEqual(['a', 'b'])
  })

  it('live proxy reflects updated source after swap', () => {
    let data: AppConfig = {
      http: { host: 'old', port: 80 },
      db: { url: 'u', pool: 1 },
      origin: 'o',
      tags: [],
    }
    const config = createLiveAccessors(() => data)
    expect(config.http.host).toBe('old')

    data = { ...data, http: { host: 'new', port: 443 } }
    expect(config.http.host).toBe('new')
    expect(config.http.port).toBe(443)
  })

  it('schema field named "origin" does not clash with framework usage', () => {
    const data = { origin: 'user-defined-origin', x: 1 }
    const config = createLiveAccessors(() => data)
    expect(config.origin).toBe('user-defined-origin')
  })

  it('config has no own methods', () => {
    const data = { a: 1 }
    const config = createLiveAccessors(() => data)
    const ownMethods = Object.keys(config).filter(k => typeof (config as never)[k] === 'function')
    expect(ownMethods).toHaveLength(0)
  })

  it('"in" operator works for present and absent keys', () => {
    const data = { a: 1 }
    const config = createLiveAccessors(() => data)
    expect('a' in config).toBe(true)
    expect('b' in config).toBe(false)
  })

  it('getOwnPropertyDescriptor returns the actual value', () => {
    const data = { http: { host: 'localhost', port: 3000 }, db: { url: 'postgres://localhost', pool: 5 }, origin: 'o', tags: [] }
    const config = createLiveAccessors(() => data)
    const originDesc = Object.getOwnPropertyDescriptor(config, 'origin')
    expect(originDesc).toBeDefined()
    expect(originDesc!.value).toBe('o')
    expect(originDesc!.enumerable).toBe(true)
    expect(originDesc!.configurable).toBe(true)
    expect(originDesc!.writable).toBe(false)
  })

  it('assigning to a config property throws TypeError', () => {
    const data = { x: 1 }
    const config = createLiveAccessors(() => data)
    expect(() => {
      (config as Record<string, unknown>).x = 99
    }).toThrow(TypeError)
  })
})
