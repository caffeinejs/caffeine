import { kSelfRefresh, Scopes, type SelfRefreshable } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools } from '../devtools.js'
import type { RefreshableRecord, RefreshRecord } from './refreshables.js'

/**
 * Refreshing from the devtools re-creates refresh-scoped injectables, and only the ones asked for: a refresh that
 * reached more would drop state an operator meant to keep, and one that reached less would leave stale values.
 */
describe('RefreshablesTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

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

  async function boot(): Promise<void> {
    app = createWebApplication().with(devTools()) as WebApplication
    app.container.bind(Flags, t => t.toSelf().lifetime(Scopes.REFRESH).labels(kFlags))
    app.container.bind(Rates, t => t.toSelf().lifetime(Scopes.REFRESH))
    app.container.bind(Catalog, t => t.toSelf().lifetime(Scopes.REFRESH))
    await app.bootstrap()
  }

  async function post(path: string, body: unknown = {}): Promise<Response> {
    return app!.request(`/devtools/refreshables${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function list(): Promise<RefreshableRecord[]> {
    return (await (await app!.request('/devtools/refreshables')).json()) as RefreshableRecord[]
  }

  it('lists the refresh-scoped injectables with their labels', async () => {
    await boot()

    const listed = await list()

    expect(listed.filter(entry => ['Flags', 'Rates', 'Catalog'].includes(entry.key))).toEqual([
      { id: expect.any(Number), key: 'Flags', labels: ['flags'] },
      { id: expect.any(Number), key: 'Rates', labels: [] },
      { id: expect.any(Number), key: 'Catalog', labels: [] },
    ])
  })

  it('re-creates every one, and refreshes a self-refreshable one in place', async () => {
    await boot()
    const flags = app!.container.get(Flags)
    const rates = app!.container.get(Rates)
    const catalog = app!.container.get(Catalog)

    const res = await post('/refreshes')

    expect(res.status).toBe(200)
    expect(app!.container.get(Flags).id).not.toBe(flags.id)
    expect(app!.container.get(Rates).id).not.toBe(rates.id)
    expect(app!.container.get(Catalog)).toBe(catalog)
    expect(catalog.reloads).toBe(1)
  })

  it('re-creates only those carrying the label named', async () => {
    await boot()
    const flags = app!.container.get(Flags)
    const rates = app!.container.get(Rates)

    const res = (await (await post('/refreshes', { label: 'flags' })).json()) as RefreshRecord

    expect(res.refreshed.map(entry => entry.key)).toEqual(['Flags'])
    expect(app!.container.get(Flags).id).not.toBe(flags.id)
    expect(app!.container.get(Rates).id).toBe(rates.id)
  })

  it('re-creates one by id, leaving the others', async () => {
    await boot()
    const flags = app!.container.get(Flags)
    const rates = app!.container.get(Rates)
    const id = (await list()).find(entry => entry.key === 'Rates')!.id

    const res = (await (await post(`/${id}/refreshes`)).json()) as RefreshRecord

    expect(res.refreshed).toEqual([{ id, key: 'Rates', labels: [] }])
    expect(app!.container.get(Rates).id).not.toBe(rates.id)
    expect(app!.container.get(Flags).id).toBe(flags.id)
  })

  it('answers 400 for a label nothing carries and 404 for an id nothing has', async () => {
    await boot()

    expect((await post('/refreshes', { label: 'nope' })).status).toBe(400)
    expect((await post('/999999/refreshes')).status).toBe(404)
    expect((await app!.request('/devtools/refreshables/999999')).status).toBe(404)
  })
})
