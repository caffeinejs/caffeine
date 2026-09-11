import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { Cache, CacheStore, MemoryCacheStore, caching } from '../index.js'

describe('caching is opt-in', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Runs before any @Cache controller is declared in this file — the global controller registry every
  // container snapshots would otherwise carry one in.
  it('does nothing to an undecorated application that never installs the feature', async () => {
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
    // No feature installed → nothing bound the store.
    expect(app.container.getOptional(CacheStore)).toBeUndefined()
  })

  it('fails at ready() when a route is decorated but the feature is not installed', async () => {
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

  it('binds the default MemoryCacheStore when the feature is installed with no store', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(caching())
      .build()
    close = () => app.close()
    await app.ready()

    expect(app.container.get(CacheStore)).toBeInstanceOf(MemoryCacheStore)
  })

  it('uses a container-bound store instead of the default', async () => {
    class MapStore extends MemoryCacheStore {}
    const container = new CaffeineIoC()
    container.bind(CacheStore, t => t.toClass(MapStore))

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .extend(caching())
      .build()
    close = () => app.close()
    await app.ready()

    expect(app.container.get(CacheStore)).toBeInstanceOf(MapStore)
  })

  it('honors c.statusHeader(...)', async () => {
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
      .extend(caching(c => c.statusHeader('X-Edge')))
      .build()
    close = () => app.close()
    await app.ready()

    const res = await app.fetch('/optin-header/data')
    expect(res.headers.get('x-edge')).toBe('MISS')
    expect(res.headers.get('x-cache')).toBeNull()
  })
})
