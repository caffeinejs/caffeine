import { describe, expect, it } from 'vitest'

import { createLiveAccessors } from '../accessor.js'
import type { ConfigHandle, ConfigLocation } from '../config.js'
import { featureConfigKey } from '../feature_key.js'

interface AppConfig {
  http: { host: string; port: number }
  db: { url: string; pool: number }
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

  it('hands arrays back as they are, without copying per read', () => {
    // Freezing is the resolved tree's job, done once when it is published — not something the handle redoes on
    // every access. So an array comes back as the very array being held: same identity, nothing allocated.
    const data = { tags: Object.freeze(['a', 'b']) }
    const config = createLiveAccessors(() => data)

    expect(config.tags).toBe(data.tags)
    expect(config.tags).toBe(config.tags)
    expect(Object.isFrozen(config.tags)).toBe(true)
    expect([...config.tags]).toEqual(['a', 'b'])
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
    const data = {
      http: { host: 'localhost', port: 3000 },
      db: { url: 'postgres://localhost', pool: 5 },
      origin: 'o',
      tags: [],
    }
    const config = createLiveAccessors(() => data)
    const originDesc = Object.getOwnPropertyDescriptor(config, 'origin')
    expect(originDesc).toBeDefined()
    expect(originDesc!.value).toBe('o')
    expect(originDesc!.enumerable).toBe(true)
    expect(originDesc!.configurable).toBe(true)
    expect(originDesc!.writable).toBe(false)
  })

  it('assigning to a config property throws ERR_CONFIG_READ_ONLY', () => {
    const data = { x: 1 }
    const config = createLiveAccessors(() => data)
    expect(() => {
      ;(config as unknown as Record<string, unknown>).x = 99
    }).toThrow(expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_READ_ONLY' }))
  })
})

/**
 * Array fields must be immutable from the outside — in the type system as much as at runtime.
 *
 * These are compile-time assertions: they pass by type-checking. `readonly (infer U)[]` is what makes them
 * hold, where `Array<infer U>` would miss a field already declared readonly, and would miss an optional array
 * entirely (a union matches neither branch and falls through as-is, mutable).
 */
describe('ConfigAccessors array typing', () => {
  interface Shape {
    mutable: string[]
    already: readonly string[]
    optional?: string[]
    servers: Array<{ host: string }>
    nested: { ports: number[] }
  }

  it('keeps every array shape read-only', () => {
    const config = createLiveAccessors<Shape>(() => ({
      mutable: ['a'],
      already: ['b'],
      optional: ['c'],
      servers: [{ host: 'h' }],
      nested: { ports: [1] },
    }))

    const mutable: readonly string[] = config.mutable
    const already: readonly string[] = config.already
    const optional: readonly string[] | undefined = config.optional
    const nested: readonly number[] = config.nested.ports
    // Elements are projected too, so an object inside a read-only list is not handed back mutable.
    const host: string = config.servers[0].host

    expect([mutable, already, optional, nested, host]).toBeDefined()

    // @ts-expect-error an array field is read-only, so it has no `push`
    expect(() => config.mutable.push('x')).toBeDefined()
    // @ts-expect-error including the optional one, which used to fall through as a mutable array
    expect(() => config.optional?.push('x')).toBeDefined()
    expect(() => {
      // @ts-expect-error and elements are read-only, not just the list holding them
      config.servers[0].host = 'other'
    }).toBeDefined()
  })
})

/**
 * A handle given a feature lookup is a *function* at run time, so it can be called with a feature key. That is
 * a change of the proxy's target, and these tests pin the things a change of target could quietly break: the
 * tree must still enumerate, spread, serialize and refuse writes exactly as the plain projection does.
 */
describe('createLiveAccessors with a feature lookup', () => {
  const kWidget = featureConfigKey<{ size: number }>('widget')
  const data = { http: { host: 'h', port: 80 }, origin: 'o' }

  const callable = (): ConfigHandle<typeof data> =>
    createLiveAccessors(
      () => data,
      undefined,
      key => (key === kWidget ? { size: 7 } : undefined),
    )

  it('answers a feature key when called', () => {
    expect(callable()(kWidget)).toEqual({ size: 7 })
  })

  it('answers undefined for a key the lookup does not know', () => {
    expect(callable()(featureConfigKey<{ size: number }>('other'))).toBeUndefined()
  })

  it('enumerates only the configuration, never the function it is carried on', () => {
    // `length` and `name` are the function's own properties. They must not leak into the tree.
    expect(Object.keys(callable()).sort()).toEqual(['http', 'origin'])
    expect('length' in callable()).toBe(false)
    // The rule is right about functions in general, and that is the point: spreading has to keep working even
    // though the handle is one.
    // oxlint-disable-next-line typescript/no-misused-spread
    expect({ ...callable() }).toEqual(data)
  })

  // `JSON.stringify` drops functions, so a callable root would serialize to nothing without a `toJSON`.
  it('serializes as the tree', () => {
    expect(JSON.stringify(callable())).toBe(JSON.stringify(data))
  })

  it('lets the configuration declare toJSON itself', () => {
    const own = { toJSON: 'not-a-function' }
    const config = createLiveAccessors(
      () => own,
      undefined,
      () => undefined,
    )

    expect(config.toJSON).toBe('not-a-function')
  })

  it('still refuses a write', () => {
    expect(() => {
      ;(callable() as unknown as Record<string, unknown>).origin = 'other'
    }).toThrow(expect.objectContaining({ name: 'ErrConfig', code: 'ERR_CONFIG_READ_ONLY' }))
  })

  // Only the root takes a lookup, so a nested node is the same plain projection it always was.
  it('leaves nested nodes uncallable', () => {
    expect(typeof callable().http).toBe('object')
  })
})

/**
 * A feature's `.config(...)` selector returns a {@link ConfigLocation}, not the feature's type, so an
 * application may declare only the part of the shape it wants to control and leave the rest to the feature's
 * defaults, its builder, or the environment.
 *
 * These are type assertions. They compile or they do not; the runtime expectations only keep vitest happy.
 */
describe('ConfigLocation', () => {
  interface ServerOptions {
    port: number
    host: string
  }

  interface Shape {
    tags: string[]
    frozen: readonly string[]
    optional?: string[]
    nested: { ports: number[] }
    hook: (n: number) => void
  }

  it('accepts a location declaring only part of the feature shape', () => {
    // The application declared `port` and nothing else. `host` comes from the builder or the environment.
    const declared = createLiveAccessors<{ port: number }>(() => ({ port: 3000 }))
    const location: ConfigLocation<ServerOptions> = declared

    expect(location.port).toBe(3000)
  })

  it('accepts a location declaring the whole shape', () => {
    const declared = createLiveAccessors<ServerOptions>(() => ({ port: 3000, host: 'localhost' }))
    const location: ConfigLocation<ServerOptions> = declared

    expect(location.host).toBe('localhost')
  })

  // A handle projects every array read-only. Widening the branch back to `T[K]` would reject every
  // array-carrying location — `kafka.brokers`, `static.mounts`, `openapi.servers`.
  it('accepts the read-only arrays a handle actually hands back', () => {
    const declared = createLiveAccessors<Shape>(() => ({
      tags: ['a'],
      frozen: ['b'],
      optional: ['c'],
      nested: { ports: [1] },
      hook: () => undefined,
    }))
    const location: ConfigLocation<Shape> = declared

    expect(location.tags?.[0]).toBe('a')
    expect(location.nested?.ports?.[0]).toBe(1)
  })

  /**
   * The only safety left once every property is optional. Without this the check is undocumented, and a change
   * to {@link ConfigAccessors} or to TypeScript could remove it without a single test going red.
   */
  it('rejects a subtree that shares no property with the feature shape', () => {
    const unrelated = createLiveAccessors<{ brokers: readonly string[] }>(() => ({ brokers: ['localhost'] }))

    // @ts-expect-error no property in common, so this is not a location for these options
    const location: ConfigLocation<ServerOptions> = unrelated

    expect(location).toBeDefined()
  })
})
