import { describe, expect, it, vi } from 'vitest'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { RecordingLogger } from '../log.testkit.js'
import { passthroughConfigSchema } from '../schema.js'
import { kMergedTree } from '../store.js'
import { testTokens } from '../tokens.testkit.js'
import type { ConfigDefinition, ConfigLayer, ConfigSchema, ConfigSource } from '../types.js'
import { hasFastProperties } from './v8.testkit.js'

function definition<T = unknown>(
  sources: ConfigSource[],
  schema: ConfigSchema<T> = passthroughConfigSchema as ConfigSchema<T>,
): ConfigDefinition<T> {
  return { schema, ...testTokens(), sources, loadTimeoutMs: 30_000 }
}

/** A live source over data the test changes, counting its loads. It cannot be reached while `fail` is set. */
function liveSource(name: string, initial: Record<string, unknown>) {
  const state = { data: initial, loads: 0, fail: false }
  const source: ConfigSource = {
    name,
    live: true,
    load: () => {
      state.loads++
      if (state.fail) {
        throw new Error(`${name} is unreachable`)
      }
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

  it('swaps in a new frozen snapshot, and leaves the one a reader took before alone', async () => {
    const { source, state } = liveSource('remote', initial)
    const store = await loadConfig<App>(definition([source], schema))
    const before = store.current

    state.data = { ...initial, server: { host: 'h', port: 2 } }
    await store.reload()

    expect(store.current).not.toBe(before)
    expect(store.current.server.port).toBe(2)
    expect(before.server.port).toBe(1)
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
    const listener = vi.fn()
    store.onChange(listener)

    state.data = { server: { host: 'h', port: 'nope' }, db: { url: 'changed' } }
    const outcome = await store.reload()

    expect(outcome.status).toBe('rejected')
    expect(outcome.error).toMatchObject({
      name: 'ErrConfigValidation',
      issues: [expect.objectContaining({ path: 'server.port' })],
    })
    expect(store.current).toBe(before)
    expect(store.current.db.url).toBe('u')
    expect(store.revision).toBe(0)
    expect(store.explain('db.url').layers[0].value).toBe('u')
    expect(listener).not.toHaveBeenCalled()
    expect(logger.at('error').map(r => r.msg)).toEqual(['configuration reload rejected'])
  })

  // A validator that throws, rather than reporting issues, still only rejects the reload: reload() never rejects,
  // and the application stays on its last good revision.
  it('rejects a reload whose validator throws, and keeps the last good revision', async () => {
    const { source, state } = liveSource('remote', { mode: 'ok' })
    const validate = (value: unknown) => {
      if ((value as { mode?: string }).mode === 'bad') {
        throw new Error('validator blew up')
      }
      return { value }
    }
    const store = await loadConfig(definition([source], { '~standard': { version: 1, vendor: 'test', validate } }))
    const before = store.current

    state.data = { mode: 'bad' }
    const outcome = await store.reload()

    expect(outcome.status).toBe('rejected')
    expect(outcome.error?.issues).toEqual([{ path: '', message: 'validator blew up' }])
    expect(store.current).toBe(before)
    expect(store.revision).toBe(0)
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

  // A rejection is a verdict on a merge, not on one source's data. Once another source changed the rest of the tree,
  // a candidate rejected before can be valid, and short-circuiting it would keep it out for good.
  it('validates a rejected candidate again once another source changed the tree', async () => {
    const a = liveSource('a', initial)
    const b = liveSource('b', {})
    const store = await loadConfig<App>(definition([a.source, b.source], schema))

    a.state.data = { ...initial, server: { host: 'h2', port: 'nope' } }
    expect((await store.reload()).status).toBe('rejected')

    // `b` overrides the port while `a` cannot be reached, so `b` is applied on its own.
    a.state.fail = true
    b.state.data = { server: { port: 2 } }
    expect((await store.reload()).status).toBe('applied')

    // `a` answers with the very candidate rejected before, which `b` has made valid.
    a.state.fail = false
    const outcome = await store.reload()

    expect(outcome).toMatchObject({ status: 'applied', changed: ['server.host'] })
    expect(store.current.server).toEqual({ host: 'h2', port: 2 })
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
      { source: 'remote', optional: false, error: expect.objectContaining({ code: 'ERR_CONFIG_SOURCE' }) },
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
    expect(store.explain('unrelated').layers[0].value).toBe(2)
    // The application reads the merged tree once, at start-up: a reload never moves it.
    expect((store[kMergedTree] as { unrelated: number }).unrelated).toBe(1)
  })

  describe('onChange', () => {
    // Synchronous on purpose: by the time the reload resolves, every listener has seen the new revision, so whoever
    // awaited the reload can rely on what the listeners did.
    it('calls a listener once per swap, before the reload resolves, with the previous snapshot and the change', async () => {
      const { source, state } = liveSource('remote', initial)
      const store = await loadConfig<App>(definition([source], schema))
      const before = store.current
      const listener = vi.fn()
      store.onChange(listener)

      state.data = { ...initial, db: { url: 'v' } }
      await store.reload()

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(store.current, before, { revision: 1, changed: ['db.url'] })

      await store.reload()

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('runs the other listeners, and logs, when one throws or rejects', async () => {
      const logger = new RecordingLogger()
      const { source, state } = liveSource('remote', initial)
      const store = await loadConfig<App>(definition([source], schema), { logger })
      const last = vi.fn()
      store.onChange(() => {
        throw new Error('boom')
      })
      store.onChange(() => Promise.reject(new Error('later')))
      store.onChange(last)

      state.data = { ...initial, db: { url: 'v' } }
      expect((await store.reload()).status).toBe('applied')

      expect(last).toHaveBeenCalledTimes(1)
      await vi.waitFor(() =>
        expect(logger.at('error').map(r => r.msg)).toEqual([
          'config change listener failed',
          'config change listener failed',
        ]),
      )
    })

    it('stops calling a listener once it unsubscribed, and every listener once the store closed', async () => {
      const { source, state } = liveSource('remote', initial)
      const store = await loadConfig<App>(definition([source], schema))
      const gone = vi.fn()
      const kept = vi.fn()
      const unsubscribe = store.onChange(gone)
      store.onChange(kept)

      unsubscribe()
      state.data = { ...initial, db: { url: 'v' } }
      await store.reload()

      expect(gone).not.toHaveBeenCalled()
      expect(kept).toHaveBeenCalledTimes(1)

      await store.close()
      state.data = { ...initial, db: { url: 'w' } }
      await store.reload()

      expect(kept).toHaveBeenCalledTimes(1)
    })
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

  // A reload requested mid-run is queued, and starts only once the one in flight has ended.
  it('lets settled wait for the reload queued behind the one in flight', async () => {
    let version = 0
    const gates: (() => void)[] = []
    const remote: ConfigSource = {
      name: 'remote',
      live: true,
      load: async () => {
        const mine = version
        if (mine > 0) {
          await new Promise<void>(resolve => gates.push(resolve))
        }
        return [{ name: 'remote', data: { value: `v${mine}` } }]
      },
    }
    const store = await loadConfig(definition([remote]))

    version = 1
    void store.reload()
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    version = 2
    void store.reload()

    let settled = false
    const settling = store.settled().then(() => {
      settled = true
    })
    gates[0]()
    await vi.waitFor(() => expect(gates).toHaveLength(2))

    expect(settled).toBe(false)

    gates[1]()
    await settling

    expect((store.current as { value: string }).value).toBe('v2')
  })

  it('closes every source', async () => {
    const closed = vi.fn()
    const store = await loadConfig(definition([{ name: 'a', load: () => [] as ConfigLayer[], close: closed }]))

    await store.close()
    await store.close()

    expect(closed).toHaveBeenCalledTimes(1)
  })

  // One source that cannot close must not keep the others open, and close() reports it rather than throwing.
  it('closes the other sources when one fails to close, and reports it', async () => {
    const logger = new RecordingLogger()
    const closed = vi.fn()
    const stuck: ConfigSource = {
      name: 'stuck',
      load: () => [],
      close: () => {
        throw new Error('socket stuck')
      },
    }
    const store = await loadConfig(definition([stuck, { name: 'b', load: () => [], close: closed }]), { logger })

    await store.close()

    expect(closed).toHaveBeenCalledOnce()
    expect(logger.at('warn')).toEqual([
      expect.objectContaining({ msg: 'config source failed', fields: expect.objectContaining({ source: 'stuck' }) }),
    ])
  })
})
