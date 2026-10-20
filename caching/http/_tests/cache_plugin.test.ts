import { CaffeineIoC } from '@caffeinejs/di'
import { ErrConfiguration } from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
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

  // Named and fastify-plugin-wrapped like any other first-party plugin: a second registration on the exact
  // same context is refused before Fastify ever sees it, same as two `.with(cors)` calls would be.
  it('refuses a second registration on the same context', async () => {
    const app = createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).statusHeader('X-First')))
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).statusHeader('X-Second')))
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(/Cannot register plugin "@caffeinejs\/caching"/)
  })

  // A route group inherits the plugins its parent registered, so a group install under a root install is the
  // same double registration — refused before any route could collect both sets of cache hooks and report every
  // outcome twice.
  it('refuses a group install under a root install', async () => {
    const router = newRouter('/nested-install').with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    router.get('/data').handler(() => ({ ok: true }))

    const app = createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .mount(router)
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(/Cannot register plugin "@caffeinejs\/caching"/)
  })

  // The start-up refusal exists for a decorated route nothing serves. A group that installed the plugin for
  // itself is served, though the root server never heard of it.
  // Programmatic routes only (`decorators: false`): the controller registry is global, and a decorated
  // controller from another test would be one more group nothing serves.
  it('serves the routes of a group that installed it for itself', async () => {
    const router = newRouter('/group-install').with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    router
      .get('/data')
      .extend(cacheControl({ ttl: 60 * Second }))
      .handler(() => ({ ok: true }))

    const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) }).mount(router)
    close = () => app.close()
    await app.bootstrap()

    expect((await app.fetch('/group-install/data')).headers.get('x-cache')).toBe('MISS')
    expect((await app.fetch('/group-install/data')).headers.get('x-cache')).toBe('HIT')
  })

  // An install belongs to its group: two groups, two stores, and an entry of one is never found in the other,
  // even under the same key.
  it('gives each group that installed it a store of its own', async () => {
    const stores = { pets: new MemoryHTTPCacheStore(), owners: new MemoryHTTPCacheStore() }
    const group = (name: keyof typeof stores) => {
      const router = newRouter(`/group-own-${name}`).with(HTTPCaching(b => b.store(stores[name])))
      router
        .get('/data')
        .extend(cacheControl({ ttl: 60 * Second, key: () => 'data' }))
        .handler(() => ({ name }))

      return router
    }

    const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) }).mount(
      group('pets'),
      group('owners'),
    )
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/group-own-pets/data')
    const owners = await app.fetch('/group-own-owners/data')

    expect(owners.headers.get('x-cache')).toBe('MISS')
    expect(await owners.json()).toEqual({ name: 'owners' })
    expect((await stores.pets.get('data'))?.payload).toBe('{"name":"pets"}')
    expect((await stores.owners.get('data'))?.payload).toBe('{"name":"owners"}')
  })

  it('still refuses a sibling group that declares caching and installed nothing', async () => {
    const served = newRouter('/group-served').with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    served
      .get('/data')
      .extend(cacheControl({ ttl: 60 * Second }))
      .handler(() => ({ ok: true }))

    const unserved = newRouter('/group-unserved')
    unserved
      .get('/data')
      .extend(cacheControl({ ttl: 60 * Second }))
      .handler(() => ({ ok: true }))

    const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .mount(served)
      .mount(unserved)
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(ErrConfiguration)
  })
})
