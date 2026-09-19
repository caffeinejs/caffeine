import { describe, expect, it, vi } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { kMergedTree } from '../store.js'
import type { ConfigDefinition, ConfigLayer, ConfigSchema, ConfigSource } from '../types.js'
import { RecordingLogger } from './log.testkit.js'
import { hasFastProperties } from './v8.testkit.js'

function definition<T = unknown>(
  sources: ConfigSource[],
  schema: ConfigSchema<T> = passthroughConfigSchema as ConfigSchema<T>,
): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

/** A live source over data the test changes, counting its loads. */
function liveSource(name: string, initial: Record<string, unknown>) {
  const state = { data: initial, loads: 0 }
  const source: ConfigSource = {
    name,
    live: true,
    load: () => {
      state.loads++
      return [{ name, data: structuredClone(state.data) as never }]
    },
  }
  return { source, state }
}

function staticSource(name: string, data: Record<string, unknown>) {
  const state = { loads: 0 }
  const source: ConfigSource = {
    name,
    load: () => {
      state.loads++
      return [{ name, data: data as never }]
    },
  }
  return { source, state }
}

interface App {
  server: { host: string; port: number }
  db: { url: string }
}

const schema = $t.Object({
  server: $t.Object({ host: $t.String(), port: $t.Number() }),
  db: $t.Object({ url: $t.String() }),
})

const initial = { server: { host: 'h', port: 1 }, db: { url: 'u' } }

describe('reload', () => {
  it('applies what a live source now says, and reports what changed', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))

    state.data = { ...initial, server: { host: 'h', port: 2 } }
    const outcome = await store.reload()

    expect(outcome).toEqual({ status: 'applied', revision: 1, changed: ['server.port'], failures: [] })
    expect(store.current.server.port).toBe(2)
    expect(store.revision).toBe(1)
  })

  // A subtree that appears on a reload comes straight from validation, which deleted its undeclared keys. V8 keeps
  // such an object in dictionary mode, where every level of a read is a hash lookup.
  it('keeps a subtree that appears on a reload in fast mode', async () => {
    const withDB = $t.Object({ app: $t.String(), db: $t.Optional($t.Object({ url: $t.String() })) })
    const { source, state } = liveSource('remote', { app: 'a' })
    const store = await loadConfig<{ app: string; db?: { url: string } }>(definition([source], withDB))

    state.data = { app: 'a', db: { extra: 1, url: 'u' } }
    await store.reload()

    expect(store.current.db).toEqual({ url: 'u' })
    expect(hasFastProperties(store.current.db as object)).toBe(true)
  })

  // The whole point: a singleton that kept the injected object reads the newest values with no refresh of its own.
  it('reaches a holder of the live object and of any node of it', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))
    const holder = { config: store.live, server: store.live.server }

    state.data = { ...initial, server: { host: 'h', port: 9 } }
    await store.reload()

    expect(holder.config.server.port).toBe(9)
    expect(holder.server.port).toBe(9)
  })

  it('keeps the identity of every subtree that did not change', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))
    const before = store.current

    state.data = { ...initial, server: { host: 'h', port: 2 } }
    await store.reload()

    expect(store.current).not.toBe(before)
    expect(store.current.db).toBe(before.db)
    expect(Object.isFrozen(store.current.server)).toBe(true)
  })

  it('changes nothing, and does not validate, when no source changed', async () => {
    const { source } = liveSource('remote', initial)
    const validate = vi.fn((value: unknown) => ({ value }))
    const store = await loadConfig(definition([source], { '~standard': { version: 1, vendor: 'spy', validate } }))
    const before = store.current
    validate.mockClear()

    const outcome = await store.reload()

    expect(outcome.status).toBe('unchanged')
    expect(validate).not.toHaveBeenCalled()
    expect(store.current).toBe(before)
    expect(store.revision).toBe(0)
  })

  // Defect 4: a refresh used to load every provider, so an edited file leaked in on an unrelated refresh.
  it('never loads a static source again', async () => {
    const fixed = staticSource('file', { db: { url: 'u' } })
    const { source } = liveSource('remote', { server: { host: 'h', port: 1 } })
    const store = await loadConfig<App>(definition([fixed.source, source], schema))

    await store.reload()
    await store.reload()

    expect(fixed.state.loads).toBe(1)
  })

  it('loads nothing at all when every source is static', async () => {
    const fixed = staticSource('file', initial)
    const store = await loadConfig<App>(definition([fixed.source], schema))

    expect(await store.reload()).toMatchObject({ status: 'unchanged' })
    expect(fixed.state.loads).toBe(1)
  })

  // Defect 2: overlapping refreshes used to let a slow, older load finish last and win.
  it('ends on the newest data when reloads overlap', async () => {
    let version = 0
    const gates: (() => void)[] = []
    let concurrent = 0
    let overlapped = false
    const remote: ConfigSource = {
      name: 'remote',
      live: true,
      load: async () => {
        const mine = version
        concurrent++
        overlapped ||= concurrent > 1
        if (mine === 1) {
          await new Promise<void>(resolve => gates.push(resolve))
        }
        concurrent--
        return [{ name: 'remote', data: { value: `v${mine}` } }]
      },
    }
    const store = await loadConfig(definition([remote]))

    version = 1
    const first = store.reload()
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    version = 2
    const second = store.reload()
    const third = store.reload()
    gates[0]()

    const outcomes = await Promise.all([first, second, third])

    expect((store.current as { value: string }).value).toBe('v2')
    expect(outcomes.map(o => o.status)).toEqual(['applied', 'applied', 'applied'])
    // The second and third requests shared one follow-up run.
    expect(outcomes[2]).toBe(outcomes[1])
    expect(store.revision).toBe(2)
    expect(overlapped).toBe(false)
  })

  // Defect 3: a refresh whose root failed validation used to publish part of itself anyway.
  it('changes nothing at all when the new configuration is invalid', async () => {
    const logger = new RecordingLogger()
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema), { logger })
    const before = store.current
    const view = store.view(c => c.server)
    const listener = vi.fn()
    store.onChange(listener)
    view.onChange(listener)

    state.data = { server: { host: 'h', port: 'nope' }, db: { url: 'changed' } }
    const outcome = await store.reload()
    await store.settled()

    expect(outcome.status).toBe('rejected')
    expect(outcome.error).toMatchObject({
      name: 'ErrConfigValidation',
      issues: [expect.objectContaining({ path: 'server.port' })],
    })
    expect(store.current).toBe(before)
    expect(store.live.db.url).toBe('u')
    expect(view.value).toBe(before.server)
    expect(store.revision).toBe(0)
    expect(store.explain('db.url').layers[0].value).toBe('u')
    expect(listener).not.toHaveBeenCalled()
    expect(logger.at('error').map(r => r.msg)).toEqual(['configuration reload rejected'])
  })

  it('reports one rejected candidate once, however often it is found again', async () => {
    const logger = new RecordingLogger()
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema), { logger })

    state.data = { ...initial, server: { host: 'h', port: 'nope' } }
    const outcomes = [await store.reload(), await store.reload(), await store.reload()]

    expect(outcomes.map(o => o.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(logger.at('error')).toHaveLength(1)

    state.data = { ...initial, server: { host: 'h', port: 'other' } }
    await store.reload()
    expect(logger.at('error')).toHaveLength(2)
  })

  it('applies a source once its data is valid again', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))

    state.data = { ...initial, server: { host: 'h', port: 'nope' } }
    await store.reload()
    state.data = { ...initial, server: { host: 'h', port: 3 } }

    expect(await store.reload()).toMatchObject({ status: 'applied' })
    expect(store.current.server.port).toBe(3)
  })

  // Defect 5: a failing provider used to drop its keys from the tree without a word.
  it('keeps the last good layers of a source that fails, and says so', async () => {
    const logger = new RecordingLogger()
    const { source, state } = liveSource('remote', initial)
    const failing = { ...source, load: source.load }
    const store = await loadConfig<App>(definition([failing], schema), { logger })

    failing.load = () => {
      throw new Error('connection reset')
    }
    const outcome = await store.reload()

    expect(outcome.status).toBe('unchanged')
    expect(outcome.failures).toEqual([
      { source: 'remote', error: expect.objectContaining({ code: 'ERR_CONFIG_SOURCE' }) },
    ])
    expect(store.current.server.port).toBe(1)
    expect(store.inspect().sources[0]).toMatchObject({ consecutiveFailures: 1, layers: ['remote'] })
    expect(logger.at('warn')).toEqual([
      expect.objectContaining({
        msg: 'config source failed',
        fields: expect.objectContaining({ source: 'remote', consecutiveFailures: 1 }),
      }),
    ])

    failing.load = source.load
    state.data = { ...initial, server: { host: 'h', port: 5 } }
    await store.reload()

    expect(store.current.server.port).toBe(5)
    expect(store.inspect().sources[0].consecutiveFailures).toBe(0)
    expect(logger.at('info').map(r => r.msg)).toContain('config source recovered')
  })

  it('takes a change in keys the schema drops without a swap', async () => {
    const { source, state } = liveSource('remote', { ...initial, unrelated: 1 })
    const store = await loadConfig<App>(definition([source], schema))
    const before = store.current

    state.data = { ...initial, unrelated: 2 }
    const outcome = await store.reload()

    expect(outcome.status).toBe('unchanged')
    expect(store.current).toBe(before)
    expect((store[kMergedTree] as { unrelated: number }).unrelated).toBe(2)
    expect(store.explain('unrelated').layers[0].value).toBe(2)
  })

  it('notifies the store listeners once per swap, with the previous snapshot and the change', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))
    const before = store.current
    const listener = vi.fn()
    store.onChange(listener)

    state.data = { ...initial, db: { url: 'v' } }
    await store.reload()
    await store.reload()
    await store.settled()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(store.current, before, { revision: 1, changed: ['db.url'] })
  })

  it('discards a reload that was in flight when the store closed', async () => {
    let loads = 0
    let release: (() => void) | undefined
    const slowOnReload: ConfigSource = {
      name: 'remote',
      live: true,
      load: async () => {
        loads++
        if (loads > 1) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
        return [{ name: 'remote', data: { ...initial, server: { host: 'h', port: loads } } }]
      },
    }
    const store = await loadConfig<App>(definition([slowOnReload], schema))

    const reloading = store.reload()
    await vi.waitFor(() => expect(release).toBeDefined())
    await store.close()
    release?.()

    expect(await reloading).toMatchObject({ status: 'unchanged' })
    expect(store.revision).toBe(0)
    expect(store.current.server.port).toBe(1)
  })

  it('loads nothing after close, and keeps the last snapshot readable', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))

    await store.close()
    state.data = { ...initial, server: { host: 'h', port: 2 } }

    expect(await store.reload()).toMatchObject({ status: 'unchanged' })
    expect(state.loads).toBe(1)
    expect(store.current.server.port).toBe(1)
    expect(store.live.server.port).toBe(1)
  })

  it('lets settled wait for a reload in flight', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))
    const seen: number[] = []
    store.onChange(config => {
      seen.push(config.server.port)
    })

    state.data = { ...initial, server: { host: 'h', port: 4 } }
    void store.reload()
    await store.settled()

    expect(seen).toEqual([4])
  })

  it('closes every source', async () => {
    const closed = vi.fn()
    const store = await loadConfig(definition([{ name: 'a', load: () => [] as ConfigLayer[], close: closed }]))

    await store.close()
    await store.close()

    expect(closed).toHaveBeenCalledTimes(1)
  })
})
