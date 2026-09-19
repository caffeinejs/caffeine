import { types } from 'node:util'

import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { InlineConfigSource } from '../sources/inline_source.js'
import type { ConfigSchema, ConfigSource } from '../types.js'

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

/** A source over data the test changes. Each load hands out its own copy, as a source has to. */
function changing(data: Record<string, unknown>) {
  const state = { data }
  const source: ConfigSource = {
    name: 'test',
    live: true,
    load: () => [{ name: 'test', data: structuredClone(state.data) as never }],
  }
  return { source, state }
}

async function setup() {
  const { source, state } = changing({ server: { port: 3000 } })
  const store = await loadConfig<App>(
    { schema, key: undefined, storeKey: undefined, sources: [source], loadTimeoutMs: 30_000 },
    { start: false },
  )
  return { store, state }
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
    const { store, state } = await setup()
    const live = store.live
    const server = store.live.server

    state.data = { server: { port: 8080 } }
    await store.reload()

    expect(store.live).toBe(live)
    expect(store.live.server).toBe(server)
    expect(server.port).toBe(8080)
  })

  // A snapshot is what a request latches: a reload landing mid-request cannot change the answers it started with.
  it('detaches a snapshot from later reloads', async () => {
    const { store, state } = await setup()
    const taken = store.current

    state.data = { server: { port: 8080 } }
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

  // A validator runs user code, and a default or a transform can hand back a constant frozen only at its top. A
  // snapshot is shared by every reader, so a write that got through one would change what all of them read.
  it('freezes all of a snapshot, even where a validator returned an object frozen only at its top', async () => {
    const first = Object.freeze({ backoff: { ms: 100 } })
    const later = Object.freeze({ backoff: { ms: 200 } })
    const validating: ConfigSchema<{ first: typeof first; later?: typeof later }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value => ({ value: (value as { later?: boolean }).later === true ? { first, later } : { first } }),
      },
    }
    const { source, state } = changing({})
    const store = await loadConfig(
      { schema: validating, key: undefined, storeKey: undefined, sources: [source], loadTimeoutMs: 30_000 },
      { start: false },
    )

    // `first` came in with the first load, `later` with a reload, as a key the previous snapshot did not have.
    state.data = { later: true }
    expect((await store.reload()).status).toBe('applied')

    for (const node of [store.current.first.backoff, store.current.later!.backoff]) {
      expect(() => {
        ;(node as { ms: number }).ms = 0
      }).toThrow(TypeError)
    }
    expect(Object.isFrozen(first.backoff)).toBe(false)
  })

  it('advances the revision only when a reload changed something', async () => {
    const { store, state } = await setup()

    await store.reload()
    expect(store.revision).toBe(0)

    state.data = { server: { port: 8080 } }
    await store.reload()
    expect(store.revision).toBe(1)
  })

  // The store's members live on the store, never on the configuration, so an application field is only a field.
  it('does not collide with an application field named current, live or snapshot', async () => {
    const source = new InlineConfigSource({ current: 'c', live: 'l', snapshot: 's' })
    const store = await loadConfig<{ current: string; live: string; snapshot: string }>({
      schema: $t.Object({ current: $t.String(), live: $t.String(), snapshot: $t.String() }),
      key: undefined,
      storeKey: undefined,
      sources: [source],
      loadTimeoutMs: 30_000,
    })

    expect(store.live).toEqual({ current: 'c', live: 'l', snapshot: 's' })
    expect(store.current.snapshot).toBe('s')
  })
})
