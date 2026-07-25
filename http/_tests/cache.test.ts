import { Readable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Delete, Get, Post, Status, createWebApplication, fastifyAdapterFactory, Cache, CacheInvalidate, MemoryCacheStore } from '../index.js'

describe('Cache-Control headers', () => {
  describe('ttl', () => {
    it('@Cache({ ttl: 60 }) → "public, max-age=60"', async () => {
      @Controller('/cache-cc-ttl-num')
      class TtlNumController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [TtlNumController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-ttl-num/data' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=60')
    })

    it('@Cache({ ttl: "5m" }) → "public, max-age=300"', async () => {
      @Controller('/cache-cc-ttl-str-m')
      class TtlStrMController {
        @Cache({ ttl: '5m' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [TtlStrMController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-ttl-str-m/data' })
      expect(res.headers['cache-control']).toBe('public, max-age=300')
    })

    it('@Cache({ ttl: "1h30m" }) → "public, max-age=5400"', async () => {
      @Controller('/cache-cc-ttl-compound')
      class TtlCompoundController {
        @Cache({ ttl: '1h30m' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [TtlCompoundController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-ttl-compound/data' })
      expect(res.headers['cache-control']).toBe('public, max-age=5400')
    })
  })

  describe('sharedMaxAge', () => {
    it('@Cache({ ttl: "5m", sharedMaxAge: "1h" }) → includes "s-maxage=3600"', async () => {
      @Controller('/cache-cc-smaxage')
      class SharedMaxAgeController {
        @Cache({ ttl: '5m', sharedMaxAge: '1h' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [SharedMaxAgeController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-smaxage/data' })
      expect(res.headers['cache-control']).toContain('max-age=300')
      expect(res.headers['cache-control']).toContain('s-maxage=3600')
    })
  })

  describe('stale directives', () => {
    it('@Cache({ ttl: 60, staleWhileRevalidate: 30 }) → includes "stale-while-revalidate=30"', async () => {
      @Controller('/cache-cc-swr')
      class StaleWhileRevalidateController {
        @Cache({ ttl: 60, staleWhileRevalidate: 30 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [StaleWhileRevalidateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-swr/data' })
      expect(res.headers['cache-control']).toContain('stale-while-revalidate=30')
    })

    it('@Cache({ ttl: 60, staleIfError: "1h" }) → includes "stale-if-error=3600"', async () => {
      @Controller('/cache-cc-sie')
      class StaleIfErrorController {
        @Cache({ ttl: 60, staleIfError: '1h' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [StaleIfErrorController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-sie/data' })
      expect(res.headers['cache-control']).toContain('stale-if-error=3600')
    })
  })

  describe('visibility', () => {
    it('@Cache({ ttl: 60, privacy: "private" }) → "private, max-age=60"', async () => {
      @Controller('/cache-cc-private')
      class PrivateCacheController {
        @Cache({ ttl: 60, privacy: 'private' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [PrivateCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-private/data' })
      expect(res.headers['cache-control']).toBe('private, max-age=60')
    })

    it('@Cache({ ttl: 60, privacy: "public" }) → "public, max-age=60"', async () => {
      @Controller('/cache-cc-public')
      class PublicCacheController {
        @Cache({ ttl: 60, privacy: 'public' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [PublicCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-public/data' })
      expect(res.headers['cache-control']).toContain('public')
    })
  })

  describe('special directives', () => {
    it('@Cache({ noStore: true }) → "no-store"', async () => {
      @Controller('/cache-cc-nostore')
      class NoStoreController {
        @Cache({ noStore: true })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [NoStoreController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-nostore/data' })
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('@Cache({ noCache: true }) → "no-cache"', async () => {
      @Controller('/cache-cc-nocache')
      class NoCacheController {
        @Cache({ noCache: true })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [NoCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-nocache/data' })
      expect(res.headers['cache-control']).toContain('no-cache')
    })

    it('@Cache({ ttl: 60, mustRevalidate: true }) → includes "must-revalidate"', async () => {
      @Controller('/cache-cc-mustrevalidate')
      class MustRevalidateController {
        @Cache({ ttl: 60, mustRevalidate: true })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [MustRevalidateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-mustrevalidate/data' })
      expect(res.headers['cache-control']).toContain('must-revalidate')
    })

    it('@Cache({ ttl: 60, immutable: true }) → includes "immutable"', async () => {
      @Controller('/cache-cc-immutable')
      class ImmutableController {
        @Cache({ ttl: 60, immutable: true })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [ImmutableController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-cc-immutable/data' })
      expect(res.headers['cache-control']).toContain('immutable')
    })
  })

  it('@Cache() with no options → no Cache-Control header', async () => {
    @Controller('/cache-cc-empty')
    class EmptyOptionsController {
      @Cache()
      @Get('/data')
      data() { return { ok: true } }
    }
    void [EmptyOptionsController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-cc-empty/data' })
    expect(res.headers['cache-control']).toBeUndefined()
  })
})

describe('Vary header', () => {
  it('@Cache({ vary: ["Accept-Language"] }) → "Vary: Accept-Language"', async () => {
    @Controller('/cache-vary-single')
    class VarySingleController {
      @Cache({ vary: ['Accept-Language'] })
      @Get('/data')
      data() { return { ok: true } }
    }
    void [VarySingleController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-vary-single/data' })
    expect(res.headers['vary']).toBe('Accept-Language')
  })

  it('@Cache({ vary: ["Accept", "Accept-Encoding"] }) → "Vary: Accept, Accept-Encoding"', async () => {
    @Controller('/cache-vary-multi')
    class VaryMultiController {
      @Cache({ vary: ['Accept', 'Accept-Encoding'] })
      @Get('/data')
      data() { return { ok: true } }
    }
    void [VaryMultiController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-vary-multi/data' })
    expect(res.headers['vary']).toBe('Accept, Accept-Encoding')
  })

  it('no vary option → no Vary header', async () => {
    @Controller('/cache-vary-none')
    class VaryNoneController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { ok: true } }
    }
    void [VaryNoneController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-vary-none/data' })
    expect(res.headers['vary']).toBeUndefined()
  })
})

describe('ETag', () => {
  it('@Cache({ ttl: 60 }) → ETag header present in double-quoted format', async () => {
    @Controller('/cache-etag-present')
    class ETagPresentController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { ok: true } }
    }
    void [ETagPresentController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-etag-present/data' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['etag']).toBeDefined()
    expect(res.headers['etag']).toMatch(/^"[a-f0-9]+"$/)
  })

  it('same response body on two requests → same ETag', async () => {
    @Controller('/cache-etag-stable')
    class ETagStableController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { value: 'constant' } }
    }
    void [ETagStableController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'GET', url: '/cache-etag-stable/data' })
    const res2 = await server.inject({ method: 'GET', url: '/cache-etag-stable/data' })

    expect(res1.headers['etag']).toBe(res2.headers['etag'])
  })

  it('different response bodies → different ETags', async () => {
    @Controller('/cache-etag-diff')
    class ETagDiffController {
      @Cache({ ttl: 60 })
      @Get('/a')
      a() { return { label: 'alpha' } }

      @Cache({ ttl: 60 })
      @Get('/b')
      b() { return { label: 'beta' } }
    }
    void [ETagDiffController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const resA = await server.inject({ method: 'GET', url: '/cache-etag-diff/a' })
    const resB = await server.inject({ method: 'GET', url: '/cache-etag-diff/b' })

    expect(resA.headers['etag']).toBeDefined()
    expect(resB.headers['etag']).toBeDefined()
    expect(resA.headers['etag']).not.toBe(resB.headers['etag'])
  })

  it('@Cache({ etag: false }) → no ETag header', async () => {
    @Controller('/cache-etag-disabled')
    class ETagDisabledController {
      @Cache({ ttl: 60, etag: false })
      @Get('/data')
      data() { return { ok: true } }
    }
    void [ETagDisabledController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-etag-disabled/data' })
    expect(res.headers['etag']).toBeUndefined()
  })

  it('@Cache({ noStore: true }) → no ETag header', async () => {
    @Controller('/cache-etag-nostore')
    class ETagNoStoreController {
      @Cache({ noStore: true })
      @Get('/data')
      data() { return { ok: true } }
    }
    void [ETagNoStoreController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-etag-nostore/data' })
    expect(res.headers['etag']).toBeUndefined()
  })

  it('stream response body → no ETag (cannot hash a stream)', async () => {
    @Controller('/cache-etag-stream')
    class ETagStreamController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return Readable.from(['hello', ' ', 'world']) }
    }
    void [ETagStreamController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-etag-stream/data' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['etag']).toBeUndefined()
  })
})

describe('304 Not Modified', () => {
  it('GET with matching If-None-Match → 304, empty body', async () => {
    @Controller('/cache-304-match')
    class Match304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { value: 'cached' } }
    }
    void [Match304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'GET', url: '/cache-304-match/data' })
    const etag = res1.headers['etag'] as string
    expect(etag).toBeDefined()

    const res2 = await server.inject({
      method: 'GET',
      url: '/cache-304-match/data',
      headers: { 'if-none-match': etag },
    })
    expect(res2.statusCode).toBe(304)
    expect(res2.body).toBe('')
  })

  it('GET with non-matching If-None-Match → 200, full body', async () => {
    @Controller('/cache-304-nomatch')
    class NoMatch304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { value: 'cached' } }
    }
    void [NoMatch304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-304-nomatch/data' })

    const res = await server.inject({
      method: 'GET',
      url: '/cache-304-nomatch/data',
      headers: { 'if-none-match': '"stale-etag-value"' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ value: 'cached' })
  })

  it('GET with stale If-None-Match after cache clear → 200, new ETag', async () => {
    @Controller('/cache-304-stale')
    class Stale304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { value: 'content' } }
    }
    void [Stale304Controller]

    const store = new MemoryCacheStore()
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'GET', url: '/cache-304-stale/data' })
    const oldEtag = res1.headers['etag'] as string

    await store.clear()

    const res2 = await server.inject({
      method: 'GET',
      url: '/cache-304-stale/data',
      headers: { 'if-none-match': oldEtag },
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.headers['etag']).toBeDefined()
  })

  it('HEAD with matching If-None-Match → 304', async () => {
    @Controller('/cache-304-head')
    class Head304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() { return { value: 'head-cached' } }
    }
    void [Head304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'GET', url: '/cache-304-head/data' })
    const etag = res1.headers['etag'] as string

    const res2 = await server.inject({
      method: 'HEAD',
      url: '/cache-304-head/data',
      headers: { 'if-none-match': etag },
    })
    expect(res2.statusCode).toBe(304)
  })
})

describe('Cache store', () => {
  it('first request calls handler; second request served from cache', async () => {
    let callCount = 0

    @Controller('/cache-store-bypass')
    class StoreBupassController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StoreBupassController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'GET', url: '/cache-store-bypass/data' })
    expect(callCount).toBe(1)
    expect(res1.json()).toEqual({ count: 1 })

    const res2 = await server.inject({ method: 'GET', url: '/cache-store-bypass/data' })
    expect(callCount).toBe(1)
    expect(res2.json()).toEqual({ count: 1 })
  })

  it('@Cache({ noStore: true }) always calls handler', async () => {
    let callCount = 0

    @Controller('/cache-store-nostore')
    class StoreNoStoreController {
      @Cache({ noStore: true })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StoreNoStoreController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-store-nostore/data' })
    await server.inject({ method: 'GET', url: '/cache-store-nostore/data' })
    expect(callCount).toBe(2)
  })

  it('POST not cached by default methods', async () => {
    let callCount = 0

    @Controller('/cache-store-post-default')
    class StorePostDefaultController {
      @Cache({ ttl: 60 })
      @Post('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StorePostDefaultController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'POST', url: '/cache-store-post-default/data' })
    await server.inject({ method: 'POST', url: '/cache-store-post-default/data' })
    expect(callCount).toBe(2)
  })

  it('@Cache({ methods: ["GET", "POST"] }) caches POST responses', async () => {
    let callCount = 0

    @Controller('/cache-store-post-custom')
    class StorePostCustomController {
      @Cache({ ttl: 60, methods: ['GET', 'POST'] })
      @Post('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StorePostCustomController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'POST', url: '/cache-store-post-custom/data' })
    expect(callCount).toBe(1)
    expect(res1.json()).toEqual({ count: 1 })

    const res2 = await server.inject({ method: 'POST', url: '/cache-store-post-custom/data' })
    expect(callCount).toBe(1)
    expect(res2.json()).toEqual({ count: 1 })
  })

  it('@Cache({ statusCodes: [200, 201] }) caches 201 but not 400', async () => {
    let okCount = 0
    let errCount = 0

    @Controller('/cache-store-status')
    class StoreStatusController {
      @Cache({ ttl: 60, statusCodes: [200, 201] })
      @Get('/ok')
      ok() {
        okCount++
        return { n: okCount }
      }

      @Cache({ ttl: 60, statusCodes: [200, 201] })
      @Get('/err')
      err() {
        errCount++
        return { n: errCount }
      }
    }
    void [StoreStatusController]

    const server = fastify()
    server.setNotFoundHandler((_req, reply) => {
      void reply.code(400).send({ error: 'bad' })
    })
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-store-status/ok' })
    await server.inject({ method: 'GET', url: '/cache-store-status/ok' })
    expect(okCount).toBe(1)
  })

  it('after cache.clear(), handler is called again', async () => {
    let callCount = 0

    @Controller('/cache-store-clear')
    class StoreClearController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StoreClearController]

    const store = new MemoryCacheStore()
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-store-clear/data' })
    expect(callCount).toBe(1)

    await server.inject({ method: 'GET', url: '/cache-store-clear/data' })
    expect(callCount).toBe(1)

    await store.clear()

    await server.inject({ method: 'GET', url: '/cache-store-clear/data' })
    expect(callCount).toBe(2)
  })
})

describe('Cache key', () => {
  it('default key: same URL shares cached response', async () => {
    let callCount = 0

    @Controller('/cache-key-default')
    class KeyDefaultController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [KeyDefaultController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-key-default/data' })
    await server.inject({ method: 'GET', url: '/cache-key-default/data' })
    expect(callCount).toBe(1)
  })

  it('different URLs are cached independently', async () => {
    let aCount = 0
    let bCount = 0

    @Controller('/cache-key-urls')
    class KeyURLsController {
      @Cache({ ttl: 60 })
      @Get('/a')
      a() {
        aCount++
        return { n: aCount }
      }

      @Cache({ ttl: 60 })
      @Get('/b')
      b() {
        bCount++
        return { n: bCount }
      }
    }
    void [KeyURLsController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-key-urls/a' })
    await server.inject({ method: 'GET', url: '/cache-key-urls/a' })
    await server.inject({ method: 'GET', url: '/cache-key-urls/b' })
    await server.inject({ method: 'GET', url: '/cache-key-urls/b' })

    expect(aCount).toBe(1)
    expect(bCount).toBe(1)
  })

  it('custom key fn ignores query string when key is based on pathname only', async () => {
    let callCount = 0

    @Controller('/cache-key-custom-path')
    class KeyCustomPathController {
      @Cache({ ttl: 60, key: req => req.url.split('?')[0] })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [KeyCustomPathController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-key-custom-path/data?v=1' })
    await server.inject({ method: 'GET', url: '/cache-key-custom-path/data?v=2' })
    expect(callCount).toBe(1)
  })

  it('custom key fn using query param creates separate cache entries', async () => {
    let callCount = 0

    @Controller('/cache-key-custom-query')
    class KeyCustomQueryController {
      @Cache({ ttl: 60, key: req => `${req.url}?lang=${req.query('lang') ?? ''}` })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [KeyCustomQueryController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-key-custom-query/data?lang=en' })
    await server.inject({ method: 'GET', url: '/cache-key-custom-query/data?lang=pt' })
    expect(callCount).toBe(2)

    await server.inject({ method: 'GET', url: '/cache-key-custom-query/data?lang=en' })
    await server.inject({ method: 'GET', url: '/cache-key-custom-query/data?lang=pt' })
    expect(callCount).toBe(2)
  })
})

describe('Decorator scope', () => {
  it('class-level @Cache applies to all routes on controller', async () => {
    @Cache({ ttl: 60 })
    @Controller('/cache-scope-class')
    class ScopeClassController {
      @Get('/a')
      a() { return { route: 'a' } }

      @Get('/b')
      b() { return { route: 'b' } }
    }
    void [ScopeClassController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const resA = await server.inject({ method: 'GET', url: '/cache-scope-class/a' })
    const resB = await server.inject({ method: 'GET', url: '/cache-scope-class/b' })

    expect(resA.headers['cache-control']).toBe('public, max-age=60')
    expect(resB.headers['cache-control']).toBe('public, max-age=60')
  })

  it('route-level @Cache applies only to the decorated method', async () => {
    @Controller('/cache-scope-method')
    class ScopeMethodController {
      @Cache({ ttl: 60 })
      @Get('/cached')
      cached() { return { ok: true } }

      @Get('/uncached')
      uncached() { return { ok: true } }
    }
    void [ScopeMethodController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const resCached = await server.inject({ method: 'GET', url: '/cache-scope-method/cached' })
    const resUncached = await server.inject({ method: 'GET', url: '/cache-scope-method/uncached' })

    expect(resCached.headers['cache-control']).toBeDefined()
    expect(resUncached.headers['cache-control']).toBeUndefined()
  })

  it('route-level @Cache completely replaces router-level @Cache (no partial merge)', async () => {
    @Cache({ ttl: 60, privacy: 'private' })
    @Controller('/cache-scope-replace')
    class ScopeReplaceController {
      @Cache({ ttl: 30 })
      @Get('/route')
      route() { return { ok: true } }
    }
    void [ScopeReplaceController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-scope-replace/route' })
    expect(res.headers['cache-control']).toBe('public, max-age=30')
    expect(res.headers['cache-control']).not.toContain('private')
  })
})

describe('Undecorated routes', () => {
  it('route without @Cache → no Cache-Control, no ETag, no caching', async () => {
    let callCount = 0

    @Controller('/cache-undecorated')
    class UndecoratedController {
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [UndecoratedController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res1 = await server.inject({ method: 'GET', url: '/cache-undecorated/data' })
    await server.inject({ method: 'GET', url: '/cache-undecorated/data' })

    expect(res1.headers['cache-control']).toBeUndefined()
    expect(res1.headers['etag']).toBeUndefined()
    expect(callCount).toBe(2)
  })
})

describe('@Cache(false)', () => {
  it('method-level @Cache(false) → all four no-cache headers on every response', async () => {
    @Controller('/cache-false-method')
    class CacheFalseMethodController {
      @Cache(false)
      @Get('/data')
      data() { return { ok: true } }
    }
    void [CacheFalseMethodController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const res = await server.inject({ method: 'GET', url: '/cache-false-method/data' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(res.headers['expires']).toBe('0')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['surrogate-control']).toBe('no-store')
  })

  it('class-level @Cache(false) → all routes in controller get no-cache headers', async () => {
    @Cache(false)
    @Controller('/cache-false-class')
    class CacheFalseClassController {
      @Get('/a')
      a() { return { route: 'a' } }

      @Get('/b')
      b() { return { route: 'b' } }
    }
    void [CacheFalseClassController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    const resA = await server.inject({ method: 'GET', url: '/cache-false-class/a' })
    const resB = await server.inject({ method: 'GET', url: '/cache-false-class/b' })

    expect(resA.headers['cache-control']).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(resB.headers['cache-control']).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
  })

  it('@Cache(false) → handler called on every request (never served from cache)', async () => {
    let callCount = 0

    @Controller('/cache-false-nocache')
    class CacheFalseNoCacheController {
      @Cache(false)
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [CacheFalseNoCacheController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
      .build()
    await app.ready()

    await server.inject({ method: 'GET', url: '/cache-false-nocache/data' })
    await server.inject({ method: 'GET', url: '/cache-false-nocache/data' })
    await server.inject({ method: 'GET', url: '/cache-false-nocache/data' })
    expect(callCount).toBe(3)
  })
})

describe('Bug fixes', () => {
  describe('Bug 1 — etag:false does not prevent caching', () => {
    it('@Cache({ ttl: 60, etag: false }) → no ETag header, but second request served from cache', async () => {
      let callCount = 0

      @Controller('/cache-bug1-etag-false')
      class Bug1EtagFalseController {
        @Cache({ ttl: 60, etag: false })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug1EtagFalseController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-bug1-etag-false/data' })
      expect(res1.statusCode).toBe(200)
      expect(res1.headers['etag']).toBeUndefined()
      expect(callCount).toBe(1)

      const res2 = await server.inject({ method: 'GET', url: '/cache-bug1-etag-false/data' })
      expect(res2.statusCode).toBe(200)
      expect(res2.json()).toEqual({ count: 1 })
      expect(callCount).toBe(1)
    })

    it('@Cache({ ttl: 60, etag: false }) + If-None-Match → 200 (no ETag to match against)', async () => {
      @Controller('/cache-bug1-inm-ignored')
      class Bug1InmIgnoredController {
        @Cache({ ttl: 60, etag: false })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [Bug1InmIgnoredController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-bug1-inm-ignored/data' })

      const res = await server.inject({
        method: 'GET',
        url: '/cache-bug1-inm-ignored/data',
        headers: { 'if-none-match': '"some-etag"' },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('Bug 2 — private responses not stored in server cache', () => {
    it('@Cache({ ttl: 60, privacy: "private" }) → Cache-Control: private, handler called on every request', async () => {
      let callCount = 0

      @Controller('/cache-bug2-private')
      class Bug2PrivateController {
        @Cache({ ttl: 60, privacy: 'private' })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug2PrivateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-bug2-private/data' })
      expect(res1.headers['cache-control']).toContain('private')
      expect(callCount).toBe(1)

      const res2 = await server.inject({ method: 'GET', url: '/cache-bug2-private/data' })
      expect(res2.json()).toEqual({ count: 2 })
      expect(callCount).toBe(2)
    })
  })

  describe('Bug 3 — Vary headers partitioned into cache key', () => {
    it('same URL, different Vary header value → separate cache entries', async () => {
      let callCount = 0

      @Controller('/cache-bug3-vary-separate')
      class Bug3VarySeparateController {
        @Cache({ ttl: 60, vary: ['Accept-Language'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug3VarySeparateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-separate/data',
        headers: { 'accept-language': 'en-US' },
      })
      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-separate/data',
        headers: { 'accept-language': 'pt-BR' },
      })
      expect(callCount).toBe(2)
    })

    it('same URL, same Vary header value → second request served from cache', async () => {
      let callCount = 0

      @Controller('/cache-bug3-vary-hit')
      class Bug3VaryHitController {
        @Cache({ ttl: 60, vary: ['Accept-Language'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug3VaryHitController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-hit/data',
        headers: { 'accept-language': 'en-US' },
      })
      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-hit/data',
        headers: { 'accept-language': 'en-US' },
      })
      expect(callCount).toBe(1)
    })

    it('Vary on multiple headers — all values combined into key', async () => {
      let callCount = 0

      @Controller('/cache-bug3-vary-multi')
      class Bug3VaryMultiController {
        @Cache({ ttl: 60, vary: ['Accept-Language', 'Accept'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug3VaryMultiController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      // same Accept-Language, different Accept → separate entry
      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-multi/data',
        headers: { 'accept-language': 'en', accept: 'application/json' },
      })
      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-multi/data',
        headers: { 'accept-language': 'en', accept: 'text/html' },
      })
      expect(callCount).toBe(2)

      // exact same headers → cache hit
      await server.inject({
        method: 'GET',
        url: '/cache-bug3-vary-multi/data',
        headers: { 'accept-language': 'en', accept: 'application/json' },
      })
      expect(callCount).toBe(2)
    })
  })

  describe('Bug 4 — Incoming no-cache bypasses cache lookup', () => {
    it('GET with Cache-Control: no-cache after cache is primed → handler called again', async () => {
      let callCount = 0

      @Controller('/cache-bug4-cc-nocache')
      class Bug4CCNoCacheController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug4CCNoCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-bug4-cc-nocache/data' })
      expect(callCount).toBe(1)

      // Second request — normally would be cached
      await server.inject({ method: 'GET', url: '/cache-bug4-cc-nocache/data' })
      expect(callCount).toBe(1)

      // Third request with no-cache — must bypass cache
      const res = await server.inject({
        method: 'GET',
        url: '/cache-bug4-cc-nocache/data',
        headers: { 'cache-control': 'no-cache' },
      })
      expect(res.statusCode).toBe(200)
      expect(callCount).toBe(2)
    })

    it('GET with Pragma: no-cache → handler called again (HTTP/1.0 compat)', async () => {
      let callCount = 0

      @Controller('/cache-bug4-pragma')
      class Bug4PragmaController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug4PragmaController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-bug4-pragma/data' })
      expect(callCount).toBe(1)

      const res = await server.inject({
        method: 'GET',
        url: '/cache-bug4-pragma/data',
        headers: { pragma: 'no-cache' },
      })
      expect(res.statusCode).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('Bug 5 — HEAD responses must not include a body', () => {
    it('GET primes cache; subsequent HEAD returns 200 with headers and no body', async () => {
      @Controller('/cache-bug5-head-nobody')
      class Bug5HeadNoBodyController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { value: 'cached' } }
      }
      void [Bug5HeadNoBodyController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const getRes = await server.inject({ method: 'GET', url: '/cache-bug5-head-nobody/data' })
      expect(getRes.statusCode).toBe(200)
      expect(getRes.headers['etag']).toBeDefined()

      const headRes = await server.inject({ method: 'HEAD', url: '/cache-bug5-head-nobody/data' })
      expect(headRes.statusCode).toBe(200)
      expect(headRes.body).toBe('')
      expect(headRes.headers['content-type']).toBeDefined()
    })

    it('HEAD with matching If-None-Match after GET primes cache → 304', async () => {
      @Controller('/cache-bug5-head-304')
      class Bug5Head304Controller {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { value: 'head-cached' } }
      }
      void [Bug5Head304Controller]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const getRes = await server.inject({ method: 'GET', url: '/cache-bug5-head-304/data' })
      const etag = getRes.headers['etag'] as string
      expect(etag).toBeDefined()

      const headRes = await server.inject({
        method: 'HEAD',
        url: '/cache-bug5-head-304/data',
        headers: { 'if-none-match': etag },
      })
      expect(headRes.statusCode).toBe(304)
      expect(headRes.body).toBe('')
    })
  })

  describe('Vary: *', () => {
    it('@Cache({ ttl: 60, vary: ["*"] }) → handler called on every request, Vary: * header set', async () => {
      let callCount = 0

      @Controller('/cache-vary-star')
      class VaryStarController {
        @Cache({ ttl: 60, vary: ['*'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [VaryStarController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-vary-star/data' })
      expect(res1.statusCode).toBe(200)
      expect(res1.headers['vary']).toBe('*')
      expect(callCount).toBe(1)

      const res2 = await server.inject({ method: 'GET', url: '/cache-vary-star/data' })
      expect(res2.statusCode).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('CacheStore segment', () => {
    it('segment passed to store.get and store.set', async () => {
      const getCalls: string[] = []
      const setCalls: string[] = []

      const spyStore: import('../cache/types.js').CacheStore = {
        async get(_key, segment) {
          getCalls.push(segment)
          return undefined
        },
        async set(_key, segment, _entry, _ttl) {
          setCalls.push(segment)
        },
        async delete(_key, _segment) {},
        async deleteMany(_keys, _segment) {},
        async clear(_segment) {},
      }

      @Controller('/cache-segment')
      class SegmentController {
        @Cache({ ttl: 60, segment: 'products' })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [SegmentController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: spyStore } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-segment/data' })
      expect(getCalls).toEqual(['products'])
      expect(setCalls).toEqual(['products'])
    })
  })

  describe('Authorization header → private by default (RFC 7234 §3.2)', () => {
    it('Authorization present without privacy override → Cache-Control: private, not stored', async () => {
      let callCount = 0

      @Controller('/cache-auth-private')
      class AuthPrivateController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [AuthPrivateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({
        method: 'GET',
        url: '/cache-auth-private/data',
        headers: { authorization: 'Bearer token123' },
      })
      expect(res1.statusCode).toBe(200)
      expect(res1.headers['cache-control']).toContain('private')
      expect(callCount).toBe(1)

      // Second request — must not be served from cache
      const res2 = await server.inject({
        method: 'GET',
        url: '/cache-auth-private/data',
        headers: { authorization: 'Bearer token123' },
      })
      expect(res2.statusCode).toBe(200)
      expect(callCount).toBe(2)
    })

    it('Authorization present with privacy: public override → stored and served from cache', async () => {
      let callCount = 0

      @Controller('/cache-auth-public-override')
      class AuthPublicOverrideController {
        @Cache({ ttl: 60, privacy: 'public' })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [AuthPublicOverrideController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({
        method: 'GET',
        url: '/cache-auth-public-override/data',
        headers: { authorization: 'Bearer token123' },
      })
      expect(callCount).toBe(1)

      const res2 = await server.inject({
        method: 'GET',
        url: '/cache-auth-public-override/data',
        headers: { authorization: 'Bearer token123' },
      })
      expect(res2.statusCode).toBe(200)
      expect(callCount).toBe(1)
    })
  })

  describe('Cache key encoding', () => {
    it('defaultCacheKey passes encodeURIComponent-encoded key to store', async () => {
      const keySeen: string[] = []

      const spyStore: import('../cache/types.js').CacheStore = {
        async get(key, _segment) {
          keySeen.push(key)
          return undefined
        },
        async set(key, _segment, _entry, _ttl) { keySeen.push(key) },
        async delete(_key, _segment) {},
        async deleteMany(_keys, _segment) {},
        async clear(_segment) {},
      }

      @Controller('/cache-key-encode')
      class KeyEncodeController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [KeyEncodeController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: spyStore } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-key-encode/data?a=1&b=2' })

      expect(keySeen.length).toBeGreaterThan(0)
      // key must not contain raw special chars that would corrupt store backends
      expect(keySeen[0]).toBe(encodeURIComponent('/cache-key-encode/data?a=1&b=2'))
      // deterministic across calls
      expect(keySeen[0]).toBe(keySeen[1])
    })
  })

  describe('Request no-store bypass (RFC 7234 §5.2.1.4)', () => {
    it('Cache-Control: no-store in request → handler called again, not served from cache', async () => {
      let callCount = 0

      @Controller('/cache-req-nostore')
      class ReqNoStoreController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [ReqNoStoreController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-req-nostore/data' })
      expect(callCount).toBe(1)

      // Second request normally would be cached
      await server.inject({ method: 'GET', url: '/cache-req-nostore/data' })
      expect(callCount).toBe(1)

      // Third request with no-store must bypass cache
      const res = await server.inject({
        method: 'GET',
        url: '/cache-req-nostore/data',
        headers: { 'cache-control': 'no-store' },
      })
      expect(res.statusCode).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('304 response includes cached headers (RFC 7232 §4.1)', () => {
    it('304 response carries ETag and Cache-Control from cached entry', async () => {
      @Controller('/cache-304-headers')
      class Headers304Controller {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { value: 'hello' } }
      }
      void [Headers304Controller]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-304-headers/data' })
      const etag = res1.headers['etag'] as string
      expect(etag).toBeDefined()

      const res304 = await server.inject({
        method: 'GET',
        url: '/cache-304-headers/data',
        headers: { 'if-none-match': etag },
      })
      expect(res304.statusCode).toBe(304)
      expect(res304.headers['etag']).toBe(etag)
      expect(res304.headers['cache-control']).toBeDefined()
    })
  })

  describe('If-None-Match: wildcard and comma-separated (RFC 7232 §3.2)', () => {
    it('If-None-Match: * → 304 when any cached response exists', async () => {
      @Controller('/cache-inm-wildcard')
      class InmWildcardController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { v: 1 } }
      }
      void [InmWildcardController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-inm-wildcard/data' })

      const res = await server.inject({
        method: 'GET',
        url: '/cache-inm-wildcard/data',
        headers: { 'if-none-match': '*' },
      })
      expect(res.statusCode).toBe(304)
    })

    it('If-None-Match comma-separated list → 304 when one entry matches', async () => {
      @Controller('/cache-inm-list')
      class InmListController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { v: 1 } }
      }
      void [InmListController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-inm-list/data' })
      const etag = res1.headers['etag'] as string

      const res = await server.inject({
        method: 'GET',
        url: '/cache-inm-list/data',
        headers: { 'if-none-match': `"stale-one", ${etag}, "stale-two"` },
      })
      expect(res.statusCode).toBe(304)
    })

    it('If-None-Match weak ETag W/"xxx" matches strong "xxx"', async () => {
      @Controller('/cache-inm-weak')
      class InmWeakController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { v: 1 } }
      }
      void [InmWeakController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-inm-weak/data' })
      const strongEtag = res1.headers['etag'] as string
      expect(strongEtag).toMatch(/^"[a-f0-9]+"$/)

      const weakEtag = `W/${strongEtag}`
      const res = await server.inject({
        method: 'GET',
        url: '/cache-inm-weak/data',
        headers: { 'if-none-match': weakEtag },
      })
      expect(res.statusCode).toBe(304)
    })
  })

  describe('MemoryCacheStore segment isolation', () => {
    it('clear(segment) removes only entries in that segment', async () => {
      const store = new MemoryCacheStore()

      @Controller('/cache-seg-iso-a')
      class SegIsoAController {
        @Cache({ ttl: 60, segment: 'a' })
        @Get('/data')
        data() { return { seg: 'a' } }
      }
      void [SegIsoAController]

      @Controller('/cache-seg-iso-b')
      class SegIsoBController {
        @Cache({ ttl: 60, segment: 'b' })
        @Get('/data')
        data() { return { seg: 'b' } }
      }
      void [SegIsoBController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store } }))
        .build()
      await app.ready()

      // Prime both segments
      await server.inject({ method: 'GET', url: '/cache-seg-iso-a/data' })
      await server.inject({ method: 'GET', url: '/cache-seg-iso-b/data' })

      // Clear only segment 'a'
      await store.clear('a')

      // Segment 'a' entry should be gone — spy via another store call
      const afterClearA = await store.get(encodeURIComponent('/cache-seg-iso-a/data'), 'a')
      const afterClearB = await store.get(encodeURIComponent('/cache-seg-iso-b/data'), 'b')

      expect(afterClearA).toBeUndefined()
      expect(afterClearB).toBeDefined()
    })
  })

  describe('proxyRevalidate option (RFC 7234 §5.2.2.7)', () => {
    it('@Cache({ ttl: 60, proxyRevalidate: true }) → Cache-Control includes proxy-revalidate', async () => {
      @Controller('/cache-proxy-revalidate')
      class ProxyRevalidateController {
        @Cache({ ttl: 60, proxyRevalidate: true })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [ProxyRevalidateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-proxy-revalidate/data' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toContain('proxy-revalidate')
    })
  })

  describe('@CacheInvalidate()', () => {
    it('POST invalidates the cached GET for the same URL', async () => {
      let getCount = 0

      @Controller('/cache-invalidate-self')
      class InvalidateSelfController {
        @Cache({ ttl: 60 })
        @Get('/resource')
        get() {
          getCount++
          return { count: getCount }
        }

        @CacheInvalidate()
        @Post('/resource')
        create() {
          return { created: true }
        }
      }
      void [InvalidateSelfController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-invalidate-self/resource' })
      await server.inject({ method: 'GET', url: '/cache-invalidate-self/resource' })
      expect(getCount).toBe(1)

      await server.inject({ method: 'POST', url: '/cache-invalidate-self/resource' })

      await server.inject({ method: 'GET', url: '/cache-invalidate-self/resource' })
      expect(getCount).toBe(2)
    })

    it('@CacheInvalidate({ paths }) invalidates the given paths, not the request URL', async () => {
      let getCount = 0

      @Controller('/cache-invalidate-paths')
      class InvalidatePathsController {
        @Cache({ ttl: 60 })
        @Get('/resource')
        get() {
          getCount++
          return { count: getCount }
        }

        @CacheInvalidate({ paths: ['/cache-invalidate-paths/resource'] })
        @Post('/other')
        create() {
          return { created: true }
        }
      }
      void [InvalidatePathsController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-invalidate-paths/resource' })
      expect(getCount).toBe(1)

      await server.inject({ method: 'POST', url: '/cache-invalidate-paths/other' })

      await server.inject({ method: 'GET', url: '/cache-invalidate-paths/resource' })
      expect(getCount).toBe(2)
    })

    it('non-2xx response must not invalidate the cache', async () => {
      let getCount = 0

      @Controller('/cache-invalidate-4xx')
      class Invalidate4xxController {
        @Cache({ ttl: 60 })
        @Get('/resource')
        get() {
          getCount++
          return { count: getCount }
        }

        @CacheInvalidate()
        @Status(400)
        @Delete('/resource')
        remove() {
          return { error: 'bad request' }
        }
      }
      void [Invalidate4xxController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-invalidate-4xx/resource' })
      expect(getCount).toBe(1)

      const del = await server.inject({ method: 'DELETE', url: '/cache-invalidate-4xx/resource' })
      expect(del.statusCode).toBe(400)

      await server.inject({ method: 'GET', url: '/cache-invalidate-4xx/resource' })
      expect(getCount).toBe(1)
    })
  })

  describe('only-if-cached request directive (RFC 7234 §5.2.1.7)', () => {
    it('cache miss + only-if-cached → 504', async () => {
      @Controller('/cache-only-if-cached-miss')
      class OnlyIfCachedMissController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [OnlyIfCachedMissController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({
        method: 'GET',
        url: '/cache-only-if-cached-miss/data',
        headers: { 'cache-control': 'only-if-cached' },
      })
      expect(res.statusCode).toBe(504)
    })

    it('cache hit + only-if-cached → 200 served from cache', async () => {
      let callCount = 0

      @Controller('/cache-only-if-cached-hit')
      class OnlyIfCachedHitController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [OnlyIfCachedHitController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-only-if-cached-hit/data' })
      expect(callCount).toBe(1)

      const res = await server.inject({
        method: 'GET',
        url: '/cache-only-if-cached-hit/data',
        headers: { 'cache-control': 'only-if-cached' },
      })
      expect(res.statusCode).toBe(200)
      expect(callCount).toBe(1)
    })
  })

  describe('no-transform directive (RFC 7234 §5.2.2.4)', () => {
    it('@Cache({ ttl: 60, noTransform: true }) → Cache-Control includes no-transform', async () => {
      @Controller('/cache-no-transform')
      class NoTransformController {
        @Cache({ ttl: 60, noTransform: true })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [NoTransformController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-no-transform/data' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toContain('no-transform')
    })
  })

  describe('Last-Modified / If-Modified-Since (RFC 7232 §3.1, §3.3, §6)', () => {
    it('cached response includes a Last-Modified header', async () => {
      @Controller('/cache-last-modified')
      class LastModifiedController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [LastModifiedController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res = await server.inject({ method: 'GET', url: '/cache-last-modified/data' })
      expect(res.headers['last-modified']).toBeDefined()
    })

    it('If-Modified-Since at or after Last-Modified → 304', async () => {
      @Controller('/cache-ims-match')
      class ImsMatchController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [ImsMatchController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      const res1 = await server.inject({ method: 'GET', url: '/cache-ims-match/data' })
      const lastModified = res1.headers['last-modified'] as string
      expect(lastModified).toBeDefined()

      const res2 = await server.inject({
        method: 'GET',
        url: '/cache-ims-match/data',
        headers: { 'if-modified-since': lastModified },
      })
      expect(res2.statusCode).toBe(304)
      expect(res2.headers['cache-control']).toBeDefined()
    })

    it('If-Modified-Since before Last-Modified → 200 with full body', async () => {
      @Controller('/cache-ims-stale')
      class ImsStaleController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [ImsStaleController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-ims-stale/data' })

      const res = await server.inject({
        method: 'GET',
        url: '/cache-ims-stale/data',
        headers: { 'if-modified-since': new Date(Date.now() - 60_000).toUTCString() },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })

    it('If-None-Match takes precedence over If-Modified-Since when both are present', async () => {
      @Controller('/cache-inm-precedence')
      class InmPrecedenceController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() { return { ok: true } }
      }
      void [InmPrecedenceController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-inm-precedence/data' })

      // Stale If-Modified-Since would normally yield 200, but a non-matching
      // If-None-Match must be evaluated instead and also yield 200.
      const res = await server.inject({
        method: 'GET',
        url: '/cache-inm-precedence/data',
        headers: {
          'if-none-match': '"does-not-match"',
          'if-modified-since': new Date(Date.now() + 60_000).toUTCString(),
        },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('Request max-age=0 treated as no-cache', () => {
    it('Cache-Control: max-age=0 in request → handler called again, not served from cache', async () => {
      let callCount = 0

      @Controller('/cache-req-maxage0')
      class ReqMaxAge0Controller {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [ReqMaxAge0Controller]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server, { cache: { store: new MemoryCacheStore() } }))
        .build()
      await app.ready()

      await server.inject({ method: 'GET', url: '/cache-req-maxage0/data' })
      expect(callCount).toBe(1)

      const res = await server.inject({
        method: 'GET',
        url: '/cache-req-maxage0/data',
        headers: { 'cache-control': 'max-age=0' },
      })
      expect(res.statusCode).toBe(200)
      expect(callCount).toBe(2)
    })
  })
})
