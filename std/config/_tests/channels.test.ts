import { channel, tracingChannel } from 'node:diagnostics_channel'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../load.js'
import {
  CONFIG_CHANNELS,
  traced,
  type ConfigChangeMessage,
  type ConfigLoadMessage,
  type ConfigReloadMessage,
} from '../observe.js'
import { passthroughConfigSchema } from '../schema.js'
import { ConfigStore } from '../store.js'
import type { ConfigSource } from '../types.js'

const unsubscribe: (() => void)[] = []

afterEach(() => {
  for (const stop of unsubscribe.splice(0)) {
    stop()
  }
})

function listen<M extends object>(name: string): { asyncEnd: M[]; error: M[] } {
  const seen = { asyncEnd: [] as M[], error: [] as M[] }
  const handlers = {
    asyncEnd: (message: M) => seen.asyncEnd.push(message),
    error: (message: M) => seen.error.push(message),
  }
  const tc = tracingChannel<M>(name)
  tc.subscribe(handlers as never)
  unsubscribe.push(() => tc.unsubscribe(handlers as never))
  return seen
}

function remote(initial: Record<string, unknown>) {
  const state = { data: initial, fail: false }
  const source: ConfigSource = {
    name: 'remote',
    live: true,
    load: () => {
      if (state.fail) {
        throw new Error('unreachable')
      }
      return [{ name: 'remote', data: state.data as never }]
    },
  }
  return { source, state }
}

function definition(sources: ConfigSource[]) {
  return { schema: passthroughConfigSchema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

describe('the diagnostics channels', () => {
  it('traces every load of every source, naming the store, the source and what asked for it', async () => {
    const loads = listen<ConfigLoadMessage>(CONFIG_CHANNELS.load)
    const { source, state } = remote({ a: 1 })

    const store = await loadConfig(definition([source]), { start: false })
    state.data = { a: 2 }
    await store.reload()

    expect(loads.asyncEnd).toEqual([
      expect.objectContaining({
        store,
        source: 'remote',
        trigger: 'start',
        result: [expect.objectContaining({ name: 'remote' })],
      }),
      expect.objectContaining({ store, source: 'remote', trigger: 'manual' }),
    ])
    expect(loads.asyncEnd[0].store).toBeInstanceOf(ConfigStore)
  })

  it('carries the error of a failed load', async () => {
    const loads = listen<ConfigLoadMessage>(CONFIG_CHANNELS.load)
    const { source, state } = remote({ a: 1 })
    const store = await loadConfig(definition([source]), { start: false })

    state.fail = true
    await store.reload()

    expect(loads.error).toEqual([
      expect.objectContaining({ source: 'remote', error: expect.objectContaining({ code: 'ERR_CONFIG_SOURCE' }) }),
    ])
  })

  it('traces every reload, ending with its outcome', async () => {
    const reloads = listen<ConfigReloadMessage>(CONFIG_CHANNELS.reload)
    const { source, state } = remote({ a: 1 })
    const store = await loadConfig(definition([source]), { start: false })

    state.data = { a: 2 }
    await store.reload()
    await store.reload()

    expect(reloads.asyncEnd).toEqual([
      expect.objectContaining({
        store,
        trigger: 'manual',
        sources: ['remote'],
        result: expect.objectContaining({ status: 'applied', changed: ['a'] }),
      }),
      expect.objectContaining({ result: expect.objectContaining({ status: 'unchanged' }) }),
    ])
  })

  it('publishes a change after each swap, and only then', async () => {
    const changes: ConfigChangeMessage[] = []
    const onChange = (message: unknown): void => {
      changes.push(message as ConfigChangeMessage)
    }
    channel(CONFIG_CHANNELS.change).subscribe(onChange)
    unsubscribe.push(() => channel(CONFIG_CHANNELS.change).unsubscribe(onChange))
    const { source, state } = remote({ a: 1, b: 1 })
    const store = await loadConfig(definition([source]), { start: false })

    await store.reload()
    state.data = { a: 1, b: 2 }
    await store.reload()

    expect(changes).toEqual([{ store, revision: 1, changed: ['b'] }])
  })

  // A channel nobody listens to must cost the store nothing: no message object, no wrapper around the work.
  it('builds no message and wraps nothing when nobody listens', async () => {
    const message = vi.fn(() => ({ store: undefined as never, trigger: 'manual' as const, sources: [] }))

    const result = await traced(
      tracingChannel<ConfigReloadMessage>('caffeinejs:config:test-unheard'),
      message,
      async () => 42,
    )

    expect(result).toBe(42)
    expect(message).not.toHaveBeenCalled()
  })
})
