import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, Get, Post, type WebApplication } from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { Minute } from '@caffeinejs/std/duration'
import { type RouteOptions } from 'fastify'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, CacheInvalidate, HTTPCaching } from '../index.js'

/**
 * What the caching hooks cost a route that does not use them: nothing. The cache attaches per route, from
 * Fastify's own `onRoute` hook, so a route in the same application that declared nothing holds no hook of it.
 * This is the guard against a later change making a cache hook unconditional.
 *
 * The plugin is installed with an observer, and none of that changes: observing adds no hook of its own.
 */

@Controller('/hooks')
class HookController {
  @Get('/plain')
  plain() {
    return { ok: true }
  }

  @CacheControl({ ttl: 5 * Minute })
  @Get('/cached')
  cached() {
    return { ok: true }
  }

  @CacheControl(false)
  @Get('/uncached')
  uncached() {
    return { ok: true }
  }

  @CacheInvalidate({ tags: ['hooks'] })
  @Post('/mutate')
  mutate() {
    return { ok: true }
  }
}
void [HookController]

const registered = new Map<string, RouteOptions>()
let app: WebApplication

beforeAll(async () => {
  app = createWebApplication()
    // onRoute sees the route definition exactly as it was handed to Fastify, after everything attached to it.
    .serverCallback((_context, server) => {
      server.addHook('onRoute', route => {
        registered.set(`${route.method} ${route.url}`, route as RouteOptions)
      })
    })
    .with(
      HTTPCaching(b =>
        b.store(new MemoryHTTPCacheStore()).observer({ onHit() {}, onMiss() {}, onStore() {}, onInvalidate() {} }),
      ),
    )
  await app.bootstrap()
})

afterAll(async () => {
  await app?.close()
})

describe('route hook slots', () => {
  it('leaves both slots empty on a route that uses no feature', () => {
    const route = registered.get('GET /hooks/plain')!

    expect(route).toBeDefined()
    expect(route.onRequest).toBeUndefined()
    expect(route.onSend).toBeUndefined()
  })

  it('gives a @CacheControl(false) route the store hook only — it has nothing to serve', () => {
    const route = registered.get('GET /hooks/uncached')!

    expect(route.onRequest).toBeUndefined()
    expect(route.onSend).toBeDefined()
  })

  it('gives a @CacheInvalidate route the eviction hook only', () => {
    const route = registered.get('POST /hooks/mutate')!

    expect(route.onRequest).toBeUndefined()
    expect(route.onSend).toBeDefined()
  })
})

describe('the server itself', () => {
  async function routesOfAPlainApplication(withCaching: boolean): Promise<string> {
    const router = newRouter('/zero')
    router.get('/plain').handler(() => ({ ok: true }))
    const plain = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
    if (withCaching) {
      plain.with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    }
    plain.mount(router)
    await plain.bootstrap()

    try {
      return plain.instance.printRoutes({ includeHooks: true, commonPrefix: false })
    } finally {
      await plain.close()
    }
  }

  // A hook attached to the server, rather than to the routes that declared caching, would run on every request
  // of the application. A route that declared nothing lists the same hooks with the plugin installed as without.
  it('carries no hook of the cache', async () => {
    expect(await routesOfAPlainApplication(true)).toBe(await routesOfAPlainApplication(false))
  })
})
