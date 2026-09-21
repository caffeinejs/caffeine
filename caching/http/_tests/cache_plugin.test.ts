import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get, createWebApplication, newRouter } from '@caffeinejs/http'
import { type RouteOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryCache } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching, cacheControl } from '../index.js'

/**
 * The caching feature reaches routes through Fastify's own `onRoute` hook, not through the adapter. These
 * tests pin that wiring: the plugin registers, decorates the request, and touches only the routes that
 * declared cache config.
 */
describe('cache plugin wiring', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('decorates the request and attaches hooks only where cache config is present', async () => {
    const registered = new Map<string, RouteOptions>()

    @Controller('/contrib')
    class ContribController {
      @Get('/plain')
      plain() {
        return { ok: true }
      }

      @CacheControl({ ttl: 60 })
      @Get('/cached')
      cached() {
        return { ok: true }
      }
    }
    void [ContribController]

    const app = createWebApplication()
      .server(undefined, server => {
        server.addHook('onRoute', route => {
          registered.set(`${route.method} ${route.url}`, route as RouteOptions)
        })
      })
      .with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    // The plugin registered: the request decoration is in place.
    expect(app.instance.hasRequestDecorator('responseCached')).toBe(true)

    // The onRoute hook only touched the decorated route.
    expect(registered.get('GET /contrib/plain')!.onSend).toBeUndefined()
    expect(typeof registered.get('GET /contrib/cached')!.onSend).toBe('function')
  })

  // Named and fastify-plugin-wrapped like any other first-party plugin: a second registration on the exact
  // same context is refused before Fastify ever sees it, same as two `.with(cors)` calls would be.
  it('refuses a second registration on the same context', async () => {
    const app = createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryCache()).statusHeader('X-First')))
      .with(HTTPCaching(b => b.store(new MemoryCache()).statusHeader('X-Second')))
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(/Cannot register plugin "@caffeinejs\/caching"/)
  })

  // A route group inherits the plugins its parent registered, so a group install under a root install is the
  // same double registration — refused before any route could collect both sets of cache hooks and report every
  // outcome twice.
  it('refuses a group install under a root install', async () => {
    const router = newRouter('/nested-install').plugin(HTTPCaching(b => b.store(new MemoryCache())))
    router.get('/data').handler(() => ({ ok: true }))

    const app = createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryCache())))
      .mount(router)
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(/Cannot register plugin "@caffeinejs\/caching"/)
  })

  // The start-up refusal exists for a decorated route nothing serves. A group that installed the plugin for
  // itself is served, though the root server never heard of it.
  // Programmatic routes only (`decorators: false`): the controller registry is global, and a decorated
  // controller from another test would be one more group nothing serves.
  it('serves the routes of a group that installed it for itself', async () => {
    const router = newRouter('/group-install').plugin(HTTPCaching(b => b.store(new MemoryCache())))
    router
      .get('/data')
      .with(cacheControl({ ttl: 60 }))
      .handler(() => ({ ok: true }))

    const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) }).mount(router)
    close = () => app.close()
    await app.ready()

    expect((await app.fetch('/group-install/data')).headers.get('x-cache')).toBe('MISS')
    expect((await app.fetch('/group-install/data')).headers.get('x-cache')).toBe('HIT')
  })

  it('still refuses a sibling group that declares caching and installed nothing', async () => {
    const served = newRouter('/group-served').plugin(HTTPCaching(b => b.store(new MemoryCache())))
    served
      .get('/data')
      .with(cacheControl({ ttl: 60 }))
      .handler(() => ({ ok: true }))

    const unserved = newRouter('/group-unserved')
    unserved
      .get('/data')
      .with(cacheControl({ ttl: 60 }))
      .handler(() => ({ ok: true }))

    const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .mount(served)
      .mount(unserved)
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })
})
