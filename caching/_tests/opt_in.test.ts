import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { Cache, CacheStore, HTTPCaching } from '../index.js'

describe('caching is opt-in', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Runs before any @Cache controller is declared in this file — the global controller registry every
  // container snapshots would otherwise carry one in.
  it('does nothing to an undecorated application that never installs the plugin', async () => {
    @Controller('/optin-plain')
    class PlainController {
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [PlainController]

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
    close = () => app.close()
    await app.ready()

    const res = await app.fetch('/optin-plain/data')
    expect(res.headers.get('x-cache')).toBeNull()
  })

  it('fails at ready() when a route is decorated but the plugin is not installed', async () => {
    @Controller('/optin-missing')
    class MissingController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [MissingController]

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  it('caches with a default MemoryCacheStore when installed with no store option', async () => {
    @Controller('/optin-default')
    class DefaultController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [DefaultController]

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .with(HTTPCaching())
      .build()
    close = () => app.close()
    await app.ready()

    const res1 = await app.fetch('/optin-default/data')
    expect(res1.headers.get('x-cache')).toBe('MISS')
    const res2 = await app.fetch('/optin-default/data')
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('resolves a container-bound store passed as a token instead of the default', async () => {
    class MapStore extends CacheStore {
      readonly ops: string[] = []
      async get() {
        this.ops.push('get')
        return undefined
      }
      async set() {
        this.ops.push('set')
      }
      async delete() {}
      async deleteMany() {}
      async clear() {}
    }

    @Controller('/optin-token-store')
    class TokenStoreController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [TokenStoreController]

    const container = new CaffeineIoC()
    container.bind(CacheStore, t => t.toClass(MapStore))

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .with(HTTPCaching(b => b.store(CacheStore)))
      .build()
    close = () => app.close()
    await app.ready()

    await app.fetch('/optin-token-store/data')

    const store = app.container.get(CacheStore) as MapStore
    expect(store.ops).toContain('set')
  })

  it('honors .statusHeader(...)', async () => {
    @Controller('/optin-header')
    class HeaderController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [HeaderController]

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .with(HTTPCaching(b => b.statusHeader('X-Edge')))
      .build()
    close = () => app.close()
    await app.ready()

    const res = await app.fetch('/optin-header/data')
    expect(res.headers.get('x-edge')).toBe('MISS')
    expect(res.headers.get('x-cache')).toBeNull()
  })
})
