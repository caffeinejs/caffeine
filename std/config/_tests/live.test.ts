import { inspect, types } from 'node:util'
import { setFlagsFromString } from 'node:v8'

import { describe, expect, it } from 'vitest'

import { createLive, syncLive } from '../live.js'
import { freezeDeep } from '../tree.js'
import type { ConfigSnapshot } from '../types.js'

interface AppConfig {
  http: { host: string; port: number; tls?: { cert: string } }
  db: { url: string; pool: number }
  origin: string
  tags: string[]
}

function snapshot<T>(value: T): ConfigSnapshot<T> {
  return freezeDeep(value) as ConfigSnapshot<T>
}

// V8's own answer to whether an object is in fast mode. The flag only lets the function below parse.
setFlagsFromString('--allow-natives-syntax')
// oxlint-disable-next-line typescript/no-implied-eval -- natives syntax parses only from source compiled after the flag
const hasFastProperties = new Function('value', 'return %HasFastProperties(value)') as (value: object) => boolean

const base: AppConfig = {
  http: { host: 'localhost', port: 3000 },
  db: { url: 'postgres://localhost', pool: 5 },
  origin: 'test-origin',
  tags: ['a', 'b'],
}

describe('the live config object', () => {
  it('reads the values of the snapshot it was built over', () => {
    const live = createLive(snapshot(base))

    expect(live.http.host).toBe('localhost')
    expect(live.http.port).toBe(3000)
    expect(live.db.url).toBe('postgres://localhost')
    expect(live.origin).toBe('test-origin')
  })

  // The point of the whole design: a singleton that kept the object, or a node of it, reads the newest values.
  it('follows a sync, through the root and through a node that was kept', () => {
    const live = createLive(snapshot(base))
    const http = live.http

    syncLive(live, snapshot({ ...base, http: { host: 'new', port: 443 } }))

    expect(live.http.host).toBe('new')
    expect(http.port).toBe(443)
  })

  it('keeps the identity of the root and of every node while the path holds an object', () => {
    const live = createLive(snapshot(base))
    const http = live.http
    const db = live.db

    syncLive(live, snapshot({ ...base, http: { host: 'x', port: 1 } }))
    syncLive(live, snapshot({ ...base, db: { url: 'y', pool: 2 } }))

    expect(live.http).toBe(http)
    expect(live.db).toBe(db)
  })

  it('hands arrays back as the frozen array of the current snapshot', () => {
    const current = snapshot(base)
    const live = createLive(current)

    expect(live.tags).toBe(current.tags)
    expect(Object.isFrozen(live.tags)).toBe(true)
  })

  // An array is a value: one kept on a field is a snapshot, and only a read through a live node moves.
  it('leaves a kept array at the values it had', () => {
    const live = createLive(snapshot(base))
    const kept = live.tags

    syncLive(live, snapshot({ ...base, tags: ['z'] }))

    expect(kept).toEqual(['a', 'b'])
    expect(live.tags).toEqual(['z'])
  })

  it('follows a key that appears and a key that goes away', () => {
    const live = createLive(snapshot(base))
    const http = live.http

    syncLive(live, snapshot({ ...base, http: { host: 'h', port: 1, tls: { cert: 'c' } }, extra: 1 }))
    expect(http.tls?.cert).toBe('c')
    expect((live as unknown as Record<string, unknown>).extra).toBe(1)

    syncLive(live, snapshot(base))
    expect('extra' in live).toBe(false)
    expect('tls' in live.http).toBe(false)
  })

  it('follows a leaf that becomes an object, and an object that becomes a leaf', () => {
    const live = createLive(snapshot({ a: 'leaf', b: { c: 1 } }))
    const b = live.b

    syncLive(live, snapshot({ a: { x: 1 }, b: 'leaf' }))

    expect(live.a).toEqual({ x: 1 })
    expect(live.b).toBe('leaf')
    // The old node is emptied rather than left serving its last values.
    expect(Object.keys(b)).toEqual([])
    expect((b as { c?: number }).c).toBeUndefined()
  })

  it('makes a new node when a path holds an object again', () => {
    const live = createLive(snapshot({ a: { x: 1 } as unknown }))
    const first = live.a

    syncLive(live, snapshot({ a: 'leaf' as unknown }))
    syncLive(live, snapshot({ a: { x: 2 } as unknown }))

    expect(live.a).not.toBe(first)
    expect(live.a).toEqual({ x: 2 })
  })

  it('skips a subtree that is the same object as before', () => {
    const current = snapshot(base)
    const live = createLive(current)
    const db = live.db

    syncLive(live, snapshot({ ...current, http: { host: 'x', port: 1 } }))

    expect(live.db).toBe(db)
    expect(live.db.url).toBe('postgres://localhost')
  })

  it('throws on a write, at any depth', () => {
    const live = createLive(snapshot(base))

    expect(() => {
      ;(live as unknown as Record<string, unknown>).origin = 'x'
    }).toThrow(TypeError)
    expect(() => {
      ;(live.http as { port: number }).port = 1
    }).toThrow(TypeError)
    expect(() => {
      ;(live as unknown as Record<string, unknown>).http = {}
    }).toThrow(TypeError)
  })

  describe('behaves as a plain object', () => {
    it('is a plain object, not a Proxy', () => {
      const live = createLive(snapshot(base))

      expect(types.isProxy(live)).toBe(false)
      expect(types.isProxy(live.http)).toBe(false)
      expect(Object.getPrototypeOf(live)).toBe(Object.prototype)
    })

    it('lists its keys', () => {
      const live = createLive(snapshot(base))

      expect(Object.keys(live).sort()).toEqual(['db', 'http', 'origin', 'tags'])
    })

    it('answers the in operator', () => {
      const live = createLive(snapshot(base))

      expect('http' in live).toBe(true)
      expect('missing' in live).toBe(false)
    })

    it('serializes and spreads to the current values', () => {
      const current = snapshot(base)
      const live = createLive(current)

      expect(JSON.stringify(live)).toBe(JSON.stringify(current))
      expect({ ...live.http }).toEqual({ host: 'localhost', port: 3000 })
    })

    it('prints its values with console.log', () => {
      const live = createLive(snapshot({ server: { host: 'h', port: 9 } }))

      expect(inspect(live.server)).toBe("{ host: 'h', port: 9 }")
    })

    it('describes every property as read-only data', () => {
      const live = createLive(snapshot(base))

      expect(Object.getOwnPropertyDescriptor(live, 'origin')).toMatchObject({
        value: 'test-origin',
        writable: false,
        enumerable: true,
      })
      expect(Object.getOwnPropertyDescriptor(live, 'http')).toMatchObject({ value: live.http, writable: false })
    })

    it('has no methods of its own, so a field called origin or snapshot is just a field', () => {
      const live = createLive(snapshot({ origin: 'o', snapshot: 's' }))

      expect(live.origin).toBe('o')
      expect(live.snapshot).toBe('s')
      expect(Object.keys(live).filter(k => typeof (live as Record<string, unknown>)[k] === 'function')).toEqual([])
    })
  })

  // A read costs what a plain object costs only while V8 keeps the node in fast mode. In dictionary mode every
  // level of a read is a hash lookup, 9 ns or more against under 1 ns. Sibling blocks with the same keys, such as
  // `db.primary` and `db.replica`, and every node of a second store repeat a key list another node already took.
  it('keeps nodes that repeat a key list in fast mode, through a second store and a sync', () => {
    const tree = { primary: { host: 'a', port: 1 }, replica: { host: 'b', port: 2 } }
    const first = createLive(snapshot(structuredClone(tree)))
    const second = createLive(snapshot(structuredClone(tree)))

    syncLive(second, snapshot({ primary: { host: 'c', port: 3 }, replica: { host: 'd', port: 4 } }))

    for (const node of [first, first.primary, first.replica, second, second.primary, second.replica]) {
      expect(hasFastProperties(node)).toBe(true)
    }
    expect(second.replica.port).toBe(4)
  })

  it('never defines __proto__, constructor or prototype', () => {
    const hostile = snapshot(JSON.parse('{"a":1,"__proto__":{"polluted":"yes"},"constructor":2}') as object)

    const live = createLive(hostile)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(live)).toEqual(['a'])
    expect(Object.getPrototypeOf(live)).toBe(Object.prototype)
  })
})
