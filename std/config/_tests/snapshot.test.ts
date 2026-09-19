import { types } from 'node:util'

import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { MutableConfigSource } from '../sources/mutable_source.js'

interface App {
  server: { port: number; paths: { live: string } }
}

const schema = $t.Object({
  server: $t.Object(
    {
      port: $t.Number({ default: 0 }),
      paths: $t.Object({ live: $t.String({ default: '/livez' }) }, { default: {} }),
    },
    { default: {} },
  ),
})

async function setup() {
  const mutable = new MutableConfigSource('test').set('server.port', 3000)
  const store = await loadConfig<App>(
    { schema, key: undefined, storeKey: undefined, sources: [mutable], loadTimeoutMs: 30_000 },
    { start: false },
  )
  return { store, mutable }
}

/**
 * Configuration is read on request paths, so a read is a property load on an ordinary object: no Proxy, no walk,
 * no allocation. These tests pin that, so nobody reintroduces a per-read cost by accident.
 */
describe('reading configuration', () => {
  it('reads through ordinary objects, never a Proxy', async () => {
    const { store } = await setup()

    for (const object of [store.live, store.live.server, store.current, store.current.server]) {
      expect(types.isProxy(object)).toBe(false)
    }
  })

  it('keeps one identity for the live object and its nodes while their fields follow a reload', async () => {
    const { store, mutable } = await setup()
    const live = store.live
    const server = store.live.server

    mutable.set('server.port', 8080)
    await store.reload()

    expect(store.live).toBe(live)
    expect(store.live.server).toBe(server)
    expect(server.port).toBe(8080)
  })

  // A snapshot is what a request latches: a reload landing mid-request cannot change the answers it started with.
  it('detaches a snapshot from later reloads', async () => {
    const { store, mutable } = await setup()
    const taken = store.current

    mutable.set('server.port', 8080)
    await store.reload()

    expect(taken.server.port).toBe(3000)
    expect(store.current.server.port).toBe(8080)
  })

  it('freezes every snapshot it hands out', async () => {
    const { store } = await setup()

    expect(Object.isFrozen(store.current)).toBe(true)
    expect(Object.isFrozen(store.current.server.paths)).toBe(true)
    expect(() => {
      ;(store.current.server as { port: number }).port = 1
    }).toThrow(TypeError)
  })

  it('advances the revision only when a reload changed something', async () => {
    const { store, mutable } = await setup()

    await store.reload()
    expect(store.revision).toBe(0)

    mutable.set('server.port', 8080)
    await store.reload()
    expect(store.revision).toBe(1)
  })

  // The store's members live on the store, never on the configuration, so an application field is only a field.
  it('does not collide with an application field named current, live or snapshot', async () => {
    const mutable = new MutableConfigSource('test').merge({ current: 'c', live: 'l', snapshot: 's' })
    const store = await loadConfig<{ current: string; live: string; snapshot: string }>({
      schema: $t.Object({ current: $t.String(), live: $t.String(), snapshot: $t.String() }),
      key: undefined,
      storeKey: undefined,
      sources: [mutable],
      loadTimeoutMs: 30_000,
    })

    expect(store.live).toEqual({ current: 'c', live: 'l', snapshot: 's' })
    expect(store.current.snapshot).toBe('s')
  })
})
