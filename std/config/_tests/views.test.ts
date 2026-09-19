import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import type { ConfigDefinition, ConfigSnapshot, ConfigSource, ConfigView } from '../types.js'
import { RecordingLogger } from './log.testkit.js'

interface App {
  database: { pool: { min: number; max: number }; url: string }
  security: { allowedOrigins: string[] }
  smtp: { host: string }
  branding: { fromAddress: string }
}

const initial: App = {
  database: { pool: { min: 1, max: 10 }, url: 'u' },
  security: { allowedOrigins: ['https://a'] },
  smtp: { host: 'mail' },
  branding: { fromAddress: 'no-reply@x' },
}

async function setup(logger?: RecordingLogger) {
  const state = { data: structuredClone(initial) as unknown as Record<string, unknown> }
  const source: ConfigSource = {
    name: 'remote',
    live: true,
    load: () => [{ name: 'remote', data: structuredClone(state.data) as never }],
  }
  const definition: ConfigDefinition<App> = {
    schema: passthroughConfigSchema as never,
    key: undefined,
    storeKey: undefined,
    sources: [source],
    loadTimeoutMs: 30_000,
  }
  const store = await loadConfig<App>(definition, { logger })

  const change = async (edit: (data: App) => void): Promise<void> => {
    const next = structuredClone(state.data) as unknown as App
    edit(next)
    state.data = next as unknown as Record<string, unknown>
    await store.reload()
    await store.settled()
  }

  return { store, change }
}

describe('ConfigStore.view', () => {
  it('holds the selection, and follows a change to it', async () => {
    const { store, change } = await setup()
    const pool = store.view(c => c.database.pool)

    expect(pool.value).toEqual({ min: 1, max: 10 })

    await change(data => {
      data.database.pool.max = 20
    })

    expect(pool.value).toEqual({ min: 1, max: 20 })
  })

  it('runs the selector once per swap and never on a read', async () => {
    const { store, change } = await setup()
    const select = vi.fn((c: ConfigSnapshot<App>) => c.database.pool)
    const pool = store.view(select)

    for (let i = 0; i < 100; i++) {
      void pool.value
    }
    expect(select).toHaveBeenCalledTimes(1)

    await change(data => {
      data.smtp.host = 'other'
    })
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('notifies only when its own selection changed', async () => {
    const { store, change } = await setup()
    const listener = vi.fn()
    store.view(c => c.database.pool).onChange(listener)

    await change(data => {
      data.smtp.host = 'other'
    })
    expect(listener).not.toHaveBeenCalled()

    await change(data => {
      data.database.pool.max = 30
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      { min: 1, max: 30 },
      { min: 1, max: 10 },
      { revision: 2, changed: ['database.pool.max'] },
    )
  })

  // A selector that builds a new object on every swap must not look like a change on every swap.
  it('keeps the identity of an assembled selection whose content did not change', async () => {
    const { store, change } = await setup()
    const listener = vi.fn()
    const mail = store.view(c => ({ host: c.smtp.host, from: c.branding.fromAddress }))
    const first = mail.value
    mail.onChange(listener)

    await change(data => {
      data.database.url = 'other'
    })

    expect(mail.value).toBe(first)
    expect(listener).not.toHaveBeenCalled()
  })

  it('derives an artifact only when the selection changed', async () => {
    const { store, change } = await setup()
    const derive = vi.fn((origins: readonly string[]) => new Set(origins))
    const allowed = store.view(c => c.security.allowedOrigins, derive)
    const first = allowed.value

    expect(allowed.value.has('https://a')).toBe(true)

    await change(data => {
      data.smtp.host = 'other'
    })
    expect(allowed.value).toBe(first)
    expect(derive).toHaveBeenCalledTimes(1)

    await change(data => {
      data.security.allowedOrigins = ['https://b']
    })
    expect(allowed.value.has('https://b')).toBe(true)
    expect(derive).toHaveBeenCalledTimes(2)
  })

  it('freezes a selection of plain data, and leaves anything else alone', async () => {
    const { store } = await setup()

    const assembled = store.view(c => ({ max: c.database.pool.max, tags: [1] }))
    const map = store.view(() => new Map([['a', 1]]))

    expect(Object.isFrozen(assembled.value)).toBe(true)
    expect(Object.isFrozen(assembled.value.tags)).toBe(true)
    expect(Object.isFrozen(map.value)).toBe(false)
  })

  // A listener is a place to act on the new configuration, so everything it could read is already there.
  it('lets a listener find the live object and every other view at the new revision', async () => {
    const { store, change } = await setup()
    const url = store.view(c => c.database.url)
    const seen: [number, string, string][] = []

    store
      .view(c => c.database.pool)
      .onChange(pool => {
        seen.push([pool.max, url.value, store.live.database.url])
      })

    await change(data => {
      data.database.pool.max = 50
      data.database.url = 'moved'
    })

    expect(seen).toEqual([[50, 'moved', 'moved']])
  })

  it('keeps its previous value when the selector throws during a swap, and says so', async () => {
    const logger = new RecordingLogger()
    const { store, change } = await setup(logger)
    let broken = false
    const pool = store.view(c => {
      if (broken) {
        throw new Error('bad selector')
      }
      return c.database.pool
    })
    const other = store.view(c => c.smtp.host)

    broken = true
    await change(data => {
      data.database.pool.max = 99
      data.smtp.host = 'moved'
    })

    expect(pool.value).toEqual({ min: 1, max: 10 })
    expect(other.value).toBe('moved')
    expect(logger.at('error').map(r => r.msg)).toEqual(['config view failed'])
  })

  it('throws to the caller when the selector throws at creation', async () => {
    const { store } = await setup()

    expect(() =>
      store.view(() => {
        throw new Error('at creation')
      }),
    ).toThrow('at creation')
  })

  it('stops updating and notifying once closed, and keeps its last value', async () => {
    const { store, change } = await setup()
    const listener = vi.fn()
    const pool = store.view(c => c.database.pool)
    pool.onChange(listener)

    pool.close()
    await change(data => {
      data.database.pool.max = 70
    })

    expect(pool.value).toEqual({ min: 1, max: 10 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('closes with the store', async () => {
    const { store } = await setup()
    const listener = vi.fn()
    const pool = store.view(c => c.database.pool)
    pool.onChange(listener)

    await store.close()

    expect(pool.value).toEqual({ min: 1, max: 10 })
  })

  // A view is three members, so a test of a consumer needs no store.
  it('can be written by hand', () => {
    const limits: ConfigView<{ perMinute: number }> = {
      value: { perMinute: 60 },
      onChange: () => () => undefined,
      close: () => undefined,
    }

    expect(limits.value.perMinute).toBe(60)
  })
})
