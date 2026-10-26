import { CaffeineIoC, kSelfRefresh, Scopes, type Container, type SelfRefreshable } from '@caffeinejs/di'
import { testClient } from '@caffeinejs/testing/http'
import { describe, expect, it } from 'vitest'

import { refreshablesRouter, RefreshablesTool } from './refreshables.js'

/**
 * Refreshing from the devtools re-creates refresh-scoped injectables, and only the ones asked for: a refresh that
 * reached more would drop state an operator meant to keep, and one that reached less would leave stale values.
 */
describe('refreshablesRouter', () => {
  const kFlags = Symbol('flags')

  class Flags {
    readonly id = Math.random()
  }

  class Rates {
    readonly id = Math.random()
  }

  class Catalog implements SelfRefreshable {
    reloads = 0;

    [kSelfRefresh](): void {
      this.reloads++
    }
  }

  async function client(bind?: (container: Container) => void) {
    const container = new CaffeineIoC({ decorators: false })

    if (bind === undefined) {
      container.bind(Flags, t => t.toSelf().lifetime(Scopes.REFRESH).labels(kFlags))
      container.bind(Rates, t => t.toSelf().lifetime(Scopes.REFRESH))
      container.bind(Catalog, t => t.toSelf().lifetime(Scopes.REFRESH))
    } else {
      bind(container)
    }

    const refreshables = testClient(refreshablesRouter(new RefreshablesTool(container)), { container })
    await refreshables.$ready()

    return { container, refreshables }
  }

  type Client = Awaited<ReturnType<typeof client>>['refreshables']

  /** The test's own refreshables: the application binds one of its own, for its configuration. */
  const OWN = ['Flags', 'Rates', 'Catalog']

  async function list(refreshables: Client) {
    return (await refreshables.refreshables.get()).json()
  }

  async function refresh(refreshables: Client, label?: string) {
    const res = await refreshables.refreshables.refreshes.post({ body: label === undefined ? {} : { label } })

    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }

    return res.json()
  }

  it('lists the refresh-scoped injectables with their labels', async () => {
    const { refreshables } = await client()
    await using _ = refreshables

    expect((await list(refreshables)).filter(entry => OWN.includes(entry.key))).toEqual([
      { id: expect.any(Number), key: 'Flags', labels: ['flags'] },
      { id: expect.any(Number), key: 'Rates', labels: [] },
      { id: expect.any(Number), key: 'Catalog', labels: [] },
    ])
  })

  it('re-creates every one, and refreshes a self-refreshable one in place', async () => {
    const { container, refreshables } = await client()
    await using _ = refreshables
    const flags = container.get(Flags)
    const rates = container.get(Rates)
    const catalog = container.get(Catalog)

    const result = await refresh(refreshables)

    expect(result.refreshed.map(entry => entry.key).filter(key => OWN.includes(key))).toEqual(OWN)
    expect(container.get(Flags).id).not.toBe(flags.id)
    expect(container.get(Rates).id).not.toBe(rates.id)
    expect(container.get(Catalog)).toBe(catalog)
    expect(catalog.reloads).toBe(1)
  })

  it('re-creates only those carrying the label named', async () => {
    const { container, refreshables } = await client()
    await using _ = refreshables
    const flags = container.get(Flags)
    const rates = container.get(Rates)

    const result = await refresh(refreshables, 'flags')

    expect(result.refreshed.map(entry => entry.key)).toEqual(['Flags'])
    expect(container.get(Flags).id).not.toBe(flags.id)
    expect(container.get(Rates).id).toBe(rates.id)
  })

  it('re-creates everything a label names, though two modules wrote that label as two symbols', async () => {
    class Pool {
      readonly id = Math.random()
    }

    class Cache {
      readonly id = Math.random()
    }

    class Anonymous {
      readonly id = Math.random()
    }

    const { container, refreshables } = await client(c => {
      c.bind(Pool, t => t.toSelf().lifetime(Scopes.REFRESH).labels(Symbol('db')))
      c.bind(Cache, t => t.toSelf().lifetime(Scopes.REFRESH).labels(Symbol('db')))
      c.bind(Anonymous, t => t.toSelf().lifetime(Scopes.REFRESH).labels(Symbol()))
    })
    await using _ = refreshables
    const pool = container.get(Pool)
    const cache = container.get(Cache)
    const anonymous = container.get(Anonymous)
    const published = (await list(refreshables)).find(entry => entry.key === 'Anonymous')!.labels[0]!

    const db = await refresh(refreshables, 'db')
    const unnamed = await refresh(refreshables, published)

    expect(db.refreshed.map(entry => entry.key)).toEqual(['Pool', 'Cache'])
    expect(container.get(Pool).id).not.toBe(pool.id)
    expect(container.get(Cache).id).not.toBe(cache.id)
    expect(unnamed.refreshed.map(entry => entry.key)).toEqual(['Anonymous'])
    expect(container.get(Anonymous).id).not.toBe(anonymous.id)
  })

  it('refreshes a binding once, though it carries two labels the name matches', async () => {
    class Pool implements SelfRefreshable {
      reloads = 0;

      [kSelfRefresh](): void {
        this.reloads++
      }
    }

    const { container, refreshables } = await client(c => {
      c.bind(Pool, t => t.toSelf().lifetime(Scopes.REFRESH).labels(Symbol('db'), Symbol('db')))
    })
    await using _ = refreshables
    const pool = container.get(Pool)

    await refresh(refreshables, 'db')

    expect(pool.reloads).toBe(1)
  })

  it('refuses a body that is not an object, rather than taking it for "refresh everything"', async () => {
    const { container, refreshables } = await client()
    await using _ = refreshables
    const rates = container.get(Rates)
    const post = (body: string) =>
      refreshables.$fetch('/refreshables/refreshes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })

    expect((await post('[]')).status).toBe(400)
    expect((await post('"flags"')).status).toBe(400)
    expect(container.get(Rates).id).toBe(rates.id)
  })

  it('re-creates one by id, leaving the others', async () => {
    const { container, refreshables } = await client()
    await using _ = refreshables
    const flags = container.get(Flags)
    const rates = container.get(Rates)
    const id = (await list(refreshables)).find(entry => entry.key === 'Rates')!.id

    const res = await refreshables.refreshables({ id: String(id) }).refreshes.post({ body: {} })

    expect(res.status).toBe(200)
    if (res.status === 200) {
      expect((await res.json()).refreshed).toEqual([{ id, key: 'Rates', labels: [] }])
    }
    expect(container.get(Rates).id).not.toBe(rates.id)
    expect(container.get(Flags).id).toBe(flags.id)
  })

  it('answers 400 for a label nothing carries and 404 for an id nothing has', async () => {
    const { refreshables } = await client()
    await using _ = refreshables

    expect((await refreshables.refreshables.refreshes.post({ body: { label: 'nope' } })).status).toBe(400)
    expect((await refreshables.refreshables({ id: '999999' }).refreshes.post({ body: {} })).status).toBe(404)
    expect((await refreshables.refreshables({ id: '999999' }).get()).status).toBe(404)
  })
})
