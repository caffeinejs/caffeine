import { CaffeineIoC } from '@caffeinejs/di'
import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { HTTPCaching, cacheControl } from '../index.js'

/** Where the plugin installs: once per context, the root or a route group, each install with its own store. */
describe('cache plugin wiring', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // An install covers its own group: a group that installed the plugin for itself is cached, though the root server
  // never heard of it.
  // Programmatic routes only (`decorators: false`): the controller registry is global, and a decorated
  // controller from another test would be one more group nothing serves.
  it('serves the routes of a group that installed it for itself', async () => {
    const router = new Router('/group-install').with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    router
      .get('/data')
      .config(cacheControl({ ttl: 60 * Second }))
      .handler(() => ({ ok: true }))

    const app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) }).mount(
      router,
    )
    close = () => app.close()
    await app.bootstrap()

    expect((await app.request('/group-install/data')).headers.get('x-cache')).toBe('MISS')
    expect((await app.request('/group-install/data')).headers.get('x-cache')).toBe('HIT')
  })

  // An install belongs to its group: two groups, two stores, and an entry of one is never found in the other,
  // even under the same key.
  it('gives each group that installed it a store of its own', async () => {
    const stores = { pets: new MemoryHTTPCacheStore(), owners: new MemoryHTTPCacheStore() }
    const group = (name: keyof typeof stores) => {
      const router = new Router(`/group-own-${name}`).with(HTTPCaching(b => b.store(stores[name])))
      router
        .get('/data')
        .config(cacheControl({ ttl: 60 * Second, key: () => 'data' }))
        .handler(() => ({ name }))

      return router
    }

    const app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) }).mount(
      group('pets'),
      group('owners'),
    )
    close = () => app.close()
    await app.bootstrap()

    await app.request('/group-own-pets/data')
    const owners = await app.request('/group-own-owners/data')

    expect(owners.headers.get('x-cache')).toBe('MISS')
    expect(await owners.json()).toEqual({ name: 'owners' })
    expect((await stores.pets.get('data'))?.payload).toBe('{"name":"pets"}')
    expect((await stores.owners.get('data'))?.payload).toBe('{"name":"owners"}')
  })

  // An install covers its own group: a sibling that declares caching and installed nothing is served uncached.
  it('serves a sibling group that declares caching and installed nothing, uncached', async () => {
    const served = new Router('/group-served').with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    served
      .get('/data')
      .config(cacheControl({ ttl: 60 * Second }))
      .handler(() => ({ ok: true }))

    let calls = 0
    const uncovered = new Router('/group-uncovered')
    uncovered
      .get('/data')
      .config(cacheControl({ ttl: 60 * Second }))
      .handler(() => ({ calls: ++calls }))

    const app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .mount(served)
      .mount(uncovered)
    close = () => app.close()
    await app.bootstrap()

    await app.request('/group-uncovered/data')
    const second = await app.request('/group-uncovered/data')

    expect([second.headers.get('x-cache'), await second.json()]).toEqual([null, { calls: 2 }])
  })
})
