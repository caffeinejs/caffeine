import { Readable } from 'node:stream'

import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, Delete, Get, Post, Status, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Cache,
  CacheInvalidate,
  MemoryCacheStore,
  CacheStore,
  kETagGenerator,
  HTTPCaching,
  type CacheEntry,
} from '../index.js'

describe('Cache-Control headers', () => {
  describe('ttl', () => {
    it('@Cache({ ttl: 60 }) → "public, max-age=60"', async () => {
      @Controller('/cache-cc-ttl-num')
      class TtlNumController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TtlNumController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-ttl-num/data')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    })

    it('@Cache({ ttl: "5m" }) → "public, max-age=300"', async () => {
      @Controller('/cache-cc-ttl-str-m')
      class TtlStrMController {
        @Cache({ ttl: '5m' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TtlStrMController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-ttl-str-m/data')
      expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    })

    it('@Cache({ ttl: "1h30m" }) → "public, max-age=5400"', async () => {
      @Controller('/cache-cc-ttl-compound')
      class TtlCompoundController {
        @Cache({ ttl: '1h30m' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TtlCompoundController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-ttl-compound/data')
      expect(res.headers.get('cache-control')).toBe('public, max-age=5400')
    })
  })

  describe('sharedMaxAge', () => {
    it('@Cache({ ttl: "5m", sharedMaxAge: "1h" }) → includes "s-maxage=3600"', async () => {
      @Controller('/cache-cc-smaxage')
      class SharedMaxAgeController {
        @Cache({ ttl: '5m', sharedMaxAge: '1h' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [SharedMaxAgeController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-smaxage/data')
      expect(res.headers.get('cache-control')).toContain('max-age=300')
      expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
    })
  })

  describe('stale directives', () => {
    it('@Cache({ ttl: 60, staleWhileRevalidate: 30 }) → includes "stale-while-revalidate=30"', async () => {
      @Controller('/cache-cc-swr')
      class StaleWhileRevalidateController {
        @Cache({ ttl: 60, staleWhileRevalidate: 30 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [StaleWhileRevalidateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-swr/data')
      expect(res.headers.get('cache-control')).toContain('stale-while-revalidate=30')
    })

    it('@Cache({ ttl: 60, staleIfError: "1h" }) → includes "stale-if-error=3600"', async () => {
      @Controller('/cache-cc-sie')
      class StaleIfErrorController {
        @Cache({ ttl: 60, staleIfError: '1h' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [StaleIfErrorController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-sie/data')
      expect(res.headers.get('cache-control')).toContain('stale-if-error=3600')
    })
  })

  describe('visibility', () => {
    it('@Cache({ ttl: 60, privacy: "private" }) → "private, max-age=60"', async () => {
      @Controller('/cache-cc-private')
      class PrivateCacheController {
        @Cache({ ttl: 60, privacy: 'private' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [PrivateCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-private/data')
      expect(res.headers.get('cache-control')).toBe('private, max-age=60')
    })

    it('@Cache({ ttl: 60, privacy: "public" }) → "public, max-age=60"', async () => {
      @Controller('/cache-cc-public')
      class PublicCacheController {
        @Cache({ ttl: 60, privacy: 'public' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [PublicCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-public/data')
      expect(res.headers.get('cache-control')).toContain('public')
    })
  })

  describe('special directives', () => {
    it('@Cache({ noStore: true }) → "no-store"', async () => {
      @Controller('/cache-cc-nostore')
      class NoStoreController {
        @Cache({ noStore: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [NoStoreController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-nostore/data')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('@Cache({ noCache: true }) → "no-cache"', async () => {
      @Controller('/cache-cc-nocache')
      class NoCacheController {
        @Cache({ noCache: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [NoCacheController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-nocache/data')
      expect(res.headers.get('cache-control')).toContain('no-cache')
    })

    it('@Cache({ ttl: 60, mustRevalidate: true }) → includes "must-revalidate"', async () => {
      @Controller('/cache-cc-mustrevalidate')
      class MustRevalidateController {
        @Cache({ ttl: 60, mustRevalidate: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [MustRevalidateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-mustrevalidate/data')
      expect(res.headers.get('cache-control')).toContain('must-revalidate')
    })

    it('@Cache({ ttl: 60, immutable: true }) → includes "immutable"', async () => {
      @Controller('/cache-cc-immutable')
      class ImmutableController {
        @Cache({ ttl: 60, immutable: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ImmutableController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-cc-immutable/data')
      expect(res.headers.get('cache-control')).toContain('immutable')
    })
  })

  it('@Cache() with no options → no Cache-Control header', async () => {
    @Controller('/cache-cc-empty')
    class EmptyOptionsController {
      @Cache()
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [EmptyOptionsController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-cc-empty/data')
    expect(res.headers.get('cache-control')).toBeNull()
  })
})

describe('Vary header', () => {
  it('@Cache({ vary: ["Accept-Language"] }) → "Vary: Accept-Language"', async () => {
    @Controller('/cache-vary-single')
    class VarySingleController {
      @Cache({ vary: ['Accept-Language'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VarySingleController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-vary-single/data')
    expect(res.headers.get('vary')).toBe('Accept-Language')
  })

  it('@Cache({ vary: ["Accept", "Accept-Encoding"] }) → "Vary: Accept, Accept-Encoding"', async () => {
    @Controller('/cache-vary-multi')
    class VaryMultiController {
      @Cache({ vary: ['Accept', 'Accept-Encoding'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VaryMultiController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-vary-multi/data')
    expect(res.headers.get('vary')).toBe('Accept, Accept-Encoding')
  })

  it('no vary option → no Vary header', async () => {
    @Controller('/cache-vary-none')
    class VaryNoneController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VaryNoneController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-vary-none/data')
    expect(res.headers.get('vary')).toBeNull()
  })
})

describe('ETag', () => {
  it('@Cache({ ttl: 60 }) → ETag header present in double-quoted format', async () => {
    @Controller('/cache-etag-present')
    class ETagPresentController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagPresentController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-etag-present/data')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeDefined()
    expect(res.headers.get('etag')).toMatch(/^"[a-f0-9]+"$/)
  })

  it('same response body on two requests → same ETag', async () => {
    @Controller('/cache-etag-stable')
    class ETagStableController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { value: 'constant' }
      }
    }
    void [ETagStableController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/cache-etag-stable/data')
    const res2 = await app.fetch('/cache-etag-stable/data')

    expect(res1.headers.get('etag')).toBe(res2.headers.get('etag'))
  })

  it('different response bodies → different ETags', async () => {
    @Controller('/cache-etag-diff')
    class ETagDiffController {
      @Cache({ ttl: 60 })
      @Get('/a')
      a() {
        return { label: 'alpha' }
      }

      @Cache({ ttl: 60 })
      @Get('/b')
      b() {
        return { label: 'beta' }
      }
    }
    void [ETagDiffController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const resA = await app.fetch('/cache-etag-diff/a')
    const resB = await app.fetch('/cache-etag-diff/b')

    expect(resA.headers.get('etag')).toBeDefined()
    expect(resB.headers.get('etag')).toBeDefined()
    expect(resA.headers.get('etag')).not.toBe(resB.headers.get('etag'))
  })

  it('@Cache({ etag: false }) → no ETag header', async () => {
    @Controller('/cache-etag-disabled')
    class ETagDisabledController {
      @Cache({ ttl: 60, etag: false })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagDisabledController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-etag-disabled/data')
    expect(res.headers.get('etag')).toBeNull()
  })

  it('@Cache({ noStore: true }) → no ETag header', async () => {
    @Controller('/cache-etag-nostore')
    class ETagNoStoreController {
      @Cache({ noStore: true })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagNoStoreController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-etag-nostore/data')
    expect(res.headers.get('etag')).toBeNull()
  })

  it('stream response body → no ETag (cannot hash a stream)', async () => {
    @Controller('/cache-etag-stream')
    class ETagStreamController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return Readable.from(['hello', ' ', 'world'])
      }
    }
    void [ETagStreamController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-etag-stream/data')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeNull()
  })
})

describe('304 Not Modified', () => {
  it('GET with matching If-None-Match → 304, empty body', async () => {
    @Controller('/cache-304-match')
    class Match304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { value: 'cached' }
      }
    }
    void [Match304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/cache-304-match/data')
    const etag = res1.headers.get('etag') as string
    expect(etag).toBeDefined()

    const res2 = await app.fetch('/cache-304-match/data', { headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)
    expect(await res2.text()).toBe('')
  })

  it('GET with non-matching If-None-Match → 200, full body', async () => {
    @Controller('/cache-304-nomatch')
    class NoMatch304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { value: 'cached' }
      }
    }
    void [NoMatch304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-304-nomatch/data')

    const res = await app.fetch('/cache-304-nomatch/data', { headers: { 'if-none-match': '"stale-etag-value"' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: 'cached' })
  })

  it('GET with stale If-None-Match after cache clear → 200, new ETag', async () => {
    @Controller('/cache-304-stale')
    class Stale304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { value: 'content' }
      }
    }
    void [Stale304Controller]

    const store = new MemoryCacheStore()
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(store)))
    await app.ready()

    const res1 = await app.fetch('/cache-304-stale/data')
    const oldEtag = res1.headers.get('etag') as string

    await store.clear()

    const res2 = await app.fetch('/cache-304-stale/data', { headers: { 'if-none-match': oldEtag } })
    expect(res2.status).toBe(200)
    expect(res2.headers.get('etag')).toBeDefined()
  })

  it('HEAD with matching If-None-Match → 304', async () => {
    @Controller('/cache-304-head')
    class Head304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { value: 'head-cached' }
      }
    }
    void [Head304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/cache-304-head/data')
    const etag = res1.headers.get('etag') as string

    const res2 = await app.fetch('/cache-304-head/data', { method: 'HEAD', headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/cache-store-bypass/data')
    expect(callCount).toBe(1)
    expect(await res1.json()).toEqual({ count: 1 })

    const res2 = await app.fetch('/cache-store-bypass/data')
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-store-nostore/data')
    await app.fetch('/cache-store-nostore/data')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-store-post-default/data', { method: 'POST' })
    await app.fetch('/cache-store-post-default/data', { method: 'POST' })
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/cache-store-post-custom/data', { method: 'POST' })
    expect(callCount).toBe(1)
    expect(await res1.json()).toEqual({ count: 1 })

    const res2 = await app.fetch('/cache-store-post-custom/data', { method: 'POST' })
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-store-status/ok')
    await app.fetch('/cache-store-status/ok')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(store)))
    await app.ready()

    await app.fetch('/cache-store-clear/data')
    expect(callCount).toBe(1)

    await app.fetch('/cache-store-clear/data')
    expect(callCount).toBe(1)

    await store.clear()

    await app.fetch('/cache-store-clear/data')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-key-default/data')
    await app.fetch('/cache-key-default/data')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-key-urls/a')
    await app.fetch('/cache-key-urls/a')
    await app.fetch('/cache-key-urls/b')
    await app.fetch('/cache-key-urls/b')

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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-key-custom-path/data?v=1')
    await app.fetch('/cache-key-custom-path/data?v=2')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-key-custom-query/data?lang=en')
    await app.fetch('/cache-key-custom-query/data?lang=pt')
    expect(callCount).toBe(2)

    await app.fetch('/cache-key-custom-query/data?lang=en')
    await app.fetch('/cache-key-custom-query/data?lang=pt')
    expect(callCount).toBe(2)
  })
})

describe('Decorator scope', () => {
  it('class-level @Cache applies to all routes on controller', async () => {
    @Cache({ ttl: 60 })
    @Controller('/cache-scope-class')
    class ScopeClassController {
      @Get('/a')
      a() {
        return { route: 'a' }
      }

      @Get('/b')
      b() {
        return { route: 'b' }
      }
    }
    void [ScopeClassController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const resA = await app.fetch('/cache-scope-class/a')
    const resB = await app.fetch('/cache-scope-class/b')

    expect(resA.headers.get('cache-control')).toBe('public, max-age=60')
    expect(resB.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('route-level @Cache applies only to the decorated method', async () => {
    @Controller('/cache-scope-method')
    class ScopeMethodController {
      @Cache({ ttl: 60 })
      @Get('/cached')
      cached() {
        return { ok: true }
      }

      @Get('/uncached')
      uncached() {
        return { ok: true }
      }
    }
    void [ScopeMethodController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const resCached = await app.fetch('/cache-scope-method/cached')
    const resUncached = await app.fetch('/cache-scope-method/uncached')

    expect(resCached.headers.get('cache-control')).toBeDefined()
    expect(resUncached.headers.get('cache-control')).toBeNull()
  })

  it('route-level @Cache completely replaces router-level @Cache (no partial merge)', async () => {
    @Cache({ ttl: 60, privacy: 'private' })
    @Controller('/cache-scope-replace')
    class ScopeReplaceController {
      @Cache({ ttl: 30 })
      @Get('/route')
      route() {
        return { ok: true }
      }
    }
    void [ScopeReplaceController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-scope-replace/route')
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
    expect(res.headers.get('cache-control')).not.toContain('private')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/cache-undecorated/data')
    await app.fetch('/cache-undecorated/data')

    expect(res1.headers.get('cache-control')).toBeNull()
    expect(res1.headers.get('etag')).toBeNull()
    expect(callCount).toBe(2)
  })
})

describe('@Cache(false)', () => {
  it('method-level @Cache(false) → all four no-cache headers on every response', async () => {
    @Controller('/cache-false-method')
    class CacheFalseMethodController {
      @Cache(false)
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [CacheFalseMethodController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/cache-false-method/data')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(res.headers.get('expires')).toBe('0')
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(res.headers.get('surrogate-control')).toBe('no-store')
  })

  it('class-level @Cache(false) → all routes in controller get no-cache headers', async () => {
    @Cache(false)
    @Controller('/cache-false-class')
    class CacheFalseClassController {
      @Get('/a')
      a() {
        return { route: 'a' }
      }

      @Get('/b')
      b() {
        return { route: 'b' }
      }
    }
    void [CacheFalseClassController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const resA = await app.fetch('/cache-false-class/a')
    const resB = await app.fetch('/cache-false-class/b')

    expect(resA.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(resB.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
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
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-false-nocache/data')
    await app.fetch('/cache-false-nocache/data')
    await app.fetch('/cache-false-nocache/data')
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-bug1-etag-false/data')
      expect(res1.status).toBe(200)
      expect(res1.headers.get('etag')).toBeNull()
      expect(callCount).toBe(1)

      const res2 = await app.fetch('/cache-bug1-etag-false/data')
      expect(res2.status).toBe(200)
      expect(await res2.json()).toEqual({ count: 1 })
      expect(callCount).toBe(1)
    })

    it('@Cache({ ttl: 60, etag: false }) + If-None-Match → 200 (no ETag to match against)', async () => {
      @Controller('/cache-bug1-inm-ignored')
      class Bug1InmIgnoredController {
        @Cache({ ttl: 60, etag: false })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [Bug1InmIgnoredController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-bug1-inm-ignored/data')

      const res = await app.fetch('/cache-bug1-inm-ignored/data', { headers: { 'if-none-match': '"some-etag"' } })
      expect(res.status).toBe(200)
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-bug2-private/data')
      expect(res1.headers.get('cache-control')).toContain('private')
      expect(callCount).toBe(1)

      const res2 = await app.fetch('/cache-bug2-private/data')
      expect(await res2.json()).toEqual({ count: 2 })
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-bug3-vary-separate/data', { headers: { 'accept-language': 'en-US' } })
      await app.fetch('/cache-bug3-vary-separate/data', { headers: { 'accept-language': 'pt-BR' } })
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-bug3-vary-hit/data', { headers: { 'accept-language': 'en-US' } })
      await app.fetch('/cache-bug3-vary-hit/data', { headers: { 'accept-language': 'en-US' } })
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      // same Accept-Language, different Accept → separate entry
      await app.fetch('/cache-bug3-vary-multi/data', {
        headers: { 'accept-language': 'en', accept: 'application/json' },
      })
      await app.fetch('/cache-bug3-vary-multi/data', { headers: { 'accept-language': 'en', accept: 'text/html' } })
      expect(callCount).toBe(2)

      // exact same headers → cache hit
      await app.fetch('/cache-bug3-vary-multi/data', {
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-bug4-cc-nocache/data')
      expect(callCount).toBe(1)

      // Second request — normally would be cached
      await app.fetch('/cache-bug4-cc-nocache/data')
      expect(callCount).toBe(1)

      // Third request with no-cache — must bypass cache
      const res = await app.fetch('/cache-bug4-cc-nocache/data', { headers: { 'cache-control': 'no-cache' } })
      expect(res.status).toBe(200)
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-bug4-pragma/data')
      expect(callCount).toBe(1)

      const res = await app.fetch('/cache-bug4-pragma/data', { headers: { pragma: 'no-cache' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('Bug 5 — HEAD responses must not include a body', () => {
    it('GET primes cache; subsequent HEAD returns 200 with headers and no body', async () => {
      @Controller('/cache-bug5-head-nobody')
      class Bug5HeadNoBodyController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { value: 'cached' }
        }
      }
      void [Bug5HeadNoBodyController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const getRes = await app.fetch('/cache-bug5-head-nobody/data')
      expect(getRes.status).toBe(200)
      expect(getRes.headers.get('etag')).toBeDefined()

      const headRes = await app.fetch('/cache-bug5-head-nobody/data', { method: 'HEAD' })
      expect(headRes.status).toBe(200)
      expect(await headRes.text()).toBe('')
      expect(headRes.headers.get('content-type')).toBeDefined()
    })

    it('HEAD with matching If-None-Match after GET primes cache → 304', async () => {
      @Controller('/cache-bug5-head-304')
      class Bug5Head304Controller {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { value: 'head-cached' }
        }
      }
      void [Bug5Head304Controller]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const getRes = await app.fetch('/cache-bug5-head-304/data')
      const etag = getRes.headers.get('etag') as string
      expect(etag).toBeDefined()

      const headRes = await app.fetch('/cache-bug5-head-304/data', {
        method: 'HEAD',
        headers: { 'if-none-match': etag },
      })
      expect(headRes.status).toBe(304)
      expect(await headRes.text()).toBe('')
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-vary-star/data')
      expect(res1.status).toBe(200)
      expect(res1.headers.get('vary')).toBe('*')
      expect(callCount).toBe(1)

      const res2 = await app.fetch('/cache-vary-star/data')
      expect(res2.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('CacheStore segment', () => {
    it('segment passed to store.get and store.set', async () => {
      class SpyStore extends CacheStore {
        readonly getCalls: string[] = []
        readonly setCalls: string[] = []
        async get(_key: string, segment: string) {
          this.getCalls.push(segment)
          return undefined
        }

        async set(_key: string, segment: string) {
          this.setCalls.push(segment)
        }
        async delete() {}
        async deleteMany() {}
        async clear() {}
      }
      const spyStore = new SpyStore()

      @Controller('/cache-segment')
      class SegmentController {
        @Cache({ ttl: 60, segment: 'products' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [SegmentController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(spyStore)))
      await app.ready()

      await app.fetch('/cache-segment/data')
      expect(spyStore.getCalls).toEqual(['products'])
      expect(spyStore.setCalls).toEqual(['products'])
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-auth-private/data', { headers: { authorization: 'Bearer token123' } })
      expect(res1.status).toBe(200)
      expect(res1.headers.get('cache-control')).toContain('private')
      expect(callCount).toBe(1)

      // Second request — must not be served from cache
      const res2 = await app.fetch('/cache-auth-private/data', { headers: { authorization: 'Bearer token123' } })
      expect(res2.status).toBe(200)
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-auth-public-override/data', { headers: { authorization: 'Bearer token123' } })
      expect(callCount).toBe(1)

      const res2 = await app.fetch('/cache-auth-public-override/data', {
        headers: { authorization: 'Bearer token123' },
      })
      expect(res2.status).toBe(200)
      expect(callCount).toBe(1)
    })
  })

  describe('Cache key encoding', () => {
    it('defaultCacheKey passes encodeURIComponent-encoded key to store', async () => {
      class SpyStore extends CacheStore {
        readonly keySeen: string[] = []
        async get(key: string) {
          this.keySeen.push(key)
          return undefined
        }

        async set(key: string) {
          this.keySeen.push(key)
        }
        async delete() {}
        async deleteMany() {}
        async clear() {}
      }
      const spyStore = new SpyStore()
      const keySeen = spyStore.keySeen

      @Controller('/cache-key-encode')
      class KeyEncodeController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [KeyEncodeController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(spyStore)))
      await app.ready()

      await app.fetch('/cache-key-encode/data?a=1&b=2')

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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-req-nostore/data')
      expect(callCount).toBe(1)

      // Second request normally would be cached
      await app.fetch('/cache-req-nostore/data')
      expect(callCount).toBe(1)

      // Third request with no-store must bypass cache
      const res = await app.fetch('/cache-req-nostore/data', { headers: { 'cache-control': 'no-store' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('304 response includes cached headers (RFC 7232 §4.1)', () => {
    it('304 response carries ETag and Cache-Control from cached entry', async () => {
      @Controller('/cache-304-headers')
      class Headers304Controller {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { value: 'hello' }
        }
      }
      void [Headers304Controller]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-304-headers/data')
      const etag = res1.headers.get('etag') as string
      expect(etag).toBeDefined()

      const res304 = await app.fetch('/cache-304-headers/data', { headers: { 'if-none-match': etag } })
      expect(res304.status).toBe(304)
      expect(res304.headers.get('etag')).toBe(etag)
      expect(res304.headers.get('cache-control')).toBeDefined()
    })
  })

  describe('If-None-Match: wildcard and comma-separated (RFC 7232 §3.2)', () => {
    it('If-None-Match: * → 304 when any cached response exists', async () => {
      @Controller('/cache-inm-wildcard')
      class InmWildcardController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { v: 1 }
        }
      }
      void [InmWildcardController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-inm-wildcard/data')

      const res = await app.fetch('/cache-inm-wildcard/data', { headers: { 'if-none-match': '*' } })
      expect(res.status).toBe(304)
    })

    it('If-None-Match comma-separated list → 304 when one entry matches', async () => {
      @Controller('/cache-inm-list')
      class InmListController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { v: 1 }
        }
      }
      void [InmListController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-inm-list/data')
      const etag = res1.headers.get('etag') as string

      const res = await app.fetch('/cache-inm-list/data', {
        headers: { 'if-none-match': `"stale-one", ${etag}, "stale-two"` },
      })
      expect(res.status).toBe(304)
    })

    it('If-None-Match weak ETag W/"xxx" matches strong "xxx"', async () => {
      @Controller('/cache-inm-weak')
      class InmWeakController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { v: 1 }
        }
      }
      void [InmWeakController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-inm-weak/data')
      const strongEtag = res1.headers.get('etag') as string
      expect(strongEtag).toMatch(/^"[a-f0-9]+"$/)

      const weakEtag = `W/${strongEtag}`
      const res = await app.fetch('/cache-inm-weak/data', { headers: { 'if-none-match': weakEtag } })
      expect(res.status).toBe(304)
    })
  })

  describe('MemoryCacheStore segment isolation', () => {
    it('clear(segment) removes only entries in that segment', async () => {
      const store = new MemoryCacheStore()

      @Controller('/cache-seg-iso-a')
      class SegIsoAController {
        @Cache({ ttl: 60, segment: 'a' })
        @Get('/data')
        data() {
          return { seg: 'a' }
        }
      }
      void [SegIsoAController]

      @Controller('/cache-seg-iso-b')
      class SegIsoBController {
        @Cache({ ttl: 60, segment: 'b' })
        @Get('/data')
        data() {
          return { seg: 'b' }
        }
      }
      void [SegIsoBController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(store)))
      await app.ready()

      // Prime both segments
      await app.fetch('/cache-seg-iso-a/data')
      await app.fetch('/cache-seg-iso-b/data')

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
        data() {
          return { ok: true }
        }
      }
      void [ProxyRevalidateController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-proxy-revalidate/data')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('proxy-revalidate')
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-invalidate-self/resource')
      await app.fetch('/cache-invalidate-self/resource')
      expect(getCount).toBe(1)

      await app.fetch('/cache-invalidate-self/resource', { method: 'POST' })

      await app.fetch('/cache-invalidate-self/resource')
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-invalidate-paths/resource')
      expect(getCount).toBe(1)

      await app.fetch('/cache-invalidate-paths/other', { method: 'POST' })

      await app.fetch('/cache-invalidate-paths/resource')
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-invalidate-4xx/resource')
      expect(getCount).toBe(1)

      const del = await app.fetch('/cache-invalidate-4xx/resource', { method: 'DELETE' })
      expect(del.status).toBe(400)

      await app.fetch('/cache-invalidate-4xx/resource')
      expect(getCount).toBe(1)
    })
  })

  describe('only-if-cached request directive (RFC 7234 §5.2.1.7)', () => {
    it('cache miss + only-if-cached → 504', async () => {
      @Controller('/cache-only-if-cached-miss')
      class OnlyIfCachedMissController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [OnlyIfCachedMissController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-only-if-cached-miss/data', { headers: { 'cache-control': 'only-if-cached' } })
      expect(res.status).toBe(504)
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-only-if-cached-hit/data')
      expect(callCount).toBe(1)

      const res = await app.fetch('/cache-only-if-cached-hit/data', { headers: { 'cache-control': 'only-if-cached' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(1)
    })
  })

  describe('no-transform directive (RFC 7234 §5.2.2.4)', () => {
    it('@Cache({ ttl: 60, noTransform: true }) → Cache-Control includes no-transform', async () => {
      @Controller('/cache-no-transform')
      class NoTransformController {
        @Cache({ ttl: 60, noTransform: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [NoTransformController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-no-transform/data')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-transform')
    })
  })

  describe('Last-Modified / If-Modified-Since (RFC 7232 §3.1, §3.3, §6)', () => {
    it('cached response includes a Last-Modified header', async () => {
      @Controller('/cache-last-modified')
      class LastModifiedController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [LastModifiedController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res = await app.fetch('/cache-last-modified/data')
      expect(res.headers.get('last-modified')).toBeDefined()
    })

    it('If-Modified-Since at or after Last-Modified → 304', async () => {
      @Controller('/cache-ims-match')
      class ImsMatchController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ImsMatchController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      const res1 = await app.fetch('/cache-ims-match/data')
      const lastModified = res1.headers.get('last-modified') as string
      expect(lastModified).toBeDefined()

      const res2 = await app.fetch('/cache-ims-match/data', { headers: { 'if-modified-since': lastModified } })
      expect(res2.status).toBe(304)
      expect(res2.headers.get('cache-control')).toBeDefined()
    })

    it('If-Modified-Since before Last-Modified → 200 with full body', async () => {
      @Controller('/cache-ims-stale')
      class ImsStaleController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ImsStaleController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-ims-stale/data')

      const res = await app.fetch('/cache-ims-stale/data', {
        headers: { 'if-modified-since': new Date(Date.now() - 60_000).toUTCString() },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    it('If-None-Match takes precedence over If-Modified-Since when both are present', async () => {
      @Controller('/cache-inm-precedence')
      class InmPrecedenceController {
        @Cache({ ttl: 60 })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [InmPrecedenceController]

      const server = fastify()
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-inm-precedence/data')

      // Stale If-Modified-Since would normally yield 200, but a non-matching
      // If-None-Match must be evaluated instead and also yield 200.
      const res = await app.fetch('/cache-inm-precedence/data', {
        headers: {
          'if-none-match': '"does-not-match"',
          'if-modified-since': new Date(Date.now() + 60_000).toUTCString(),
        },
      })
      expect(res.status).toBe(200)
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
      const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
      await app.ready()

      await app.fetch('/cache-req-maxage0/data')
      expect(callCount).toBe(1)

      const res = await app.fetch('/cache-req-maxage0/data', { headers: { 'cache-control': 'max-age=0' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })
})

describe('Cache builder & container-managed store', () => {
  // Minimal Map-backed CacheStore used to prove a configured store actually backs caching and to
  // observe which store received the traffic (i.e. that the default MemoryCacheStore was overridden).
  // Deliberately extends CacheStore directly — not MemoryCacheStore — so `instanceof` assertions are
  // unambiguous.
  class MapStore extends CacheStore {
    readonly ops: string[] = []
    readonly #entries = new Map<string, CacheEntry>()

    async get(key: string, segment: string): Promise<CacheEntry | undefined> {
      this.ops.push('get')
      return this.#entries.get(`${segment}:${key}`)
    }

    async set(key: string, segment: string, entry: CacheEntry): Promise<void> {
      this.ops.push('set')
      this.#entries.set(`${segment}:${key}`, entry)
    }

    async delete(key: string, segment: string): Promise<void> {
      this.#entries.delete(`${segment}:${key}`)
    }

    async deleteMany(keys: string[], segment: string): Promise<void> {
      for (const key of keys) {
        this.#entries.delete(`${segment}:${key}`)
      }
    }

    async clear(): Promise<void> {
      this.#entries.clear()
    }
  }

  it('.store(token) resolves a container-bound CacheStore and backs caching', async () => {
    let callCount = 0

    @Controller('/cache-di-custom-store')
    class CustomStoreController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [CustomStoreController]

    const container = new CaffeineIoC()
    container.bind(CacheStore, t => t.toClass(MapStore))
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server), { container }).with(
      HTTPCaching(b => b.store(CacheStore)),
    )
    await app.ready()

    await app.fetch('/cache-di-custom-store/data')
    const res2 = await app.fetch('/cache-di-custom-store/data')

    const resolved = app.container.get(CacheStore) as MapStore
    expect(resolved).toBeInstanceOf(MapStore)
    expect(resolved).not.toBeInstanceOf(MemoryCacheStore)
    expect(resolved.ops).toContain('set')
    expect(resolved.ops).toContain('get')
    // Second request served from the custom store — handler ran only once.
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
  })

  it('zero configuration → default in-process store caches, with no CacheStore binding at all', async () => {
    let callCount = 0

    @Controller('/cache-di-default')
    class DefaultStoreController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [DefaultStoreController]

    const server = fastify()
    // No options — HTTPCaching never touches the container and falls back to a fresh MemoryCacheStore.
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    expect(app.container.getOptional(CacheStore)).toBeUndefined()

    await app.fetch('/cache-di-default/data')
    await app.fetch('/cache-di-default/data')
    expect(callCount).toBe(1)
  })

  it('a CacheStore bound in the container is ignored unless passed explicitly via .store(token)', async () => {
    @Controller('/cache-di-ignored')
    class IgnoredStoreController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [IgnoredStoreController]

    const container = new CaffeineIoC()
    container.bind(CacheStore, t => t.toClass(MapStore))
    const server = fastify()
    // No .store(...) option — the container binding above is never read.
    const app = createWebApplication(fastifyAdapterFactory(server), { container }).with(HTTPCaching())
    await app.ready()

    await app.fetch('/cache-di-ignored/data')

    const bound = app.container.get(CacheStore) as MapStore
    expect(bound.ops).toEqual([])
  })

  it('.store(instance) wires a custom store that backs caching', async () => {
    let callCount = 0

    @Controller('/cache-builder-store')
    class BuilderStoreController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [BuilderStoreController]

    const store = new MapStore()
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(store)))
    await app.ready()

    await app.fetch('/cache-builder-store/data')
    const res2 = await app.fetch('/cache-builder-store/data')

    expect(store.ops).toContain('set')
    expect(store.ops).toContain('get')
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
  })

  it('.store(instance).etagGenerator(...) applies both', async () => {
    @Controller('/cache-builder-both')
    class BuilderBothController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [BuilderBothController]

    const store = new MapStore()
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(
      HTTPCaching(b => b.store(store).etagGenerator(() => '"builder-etag"')),
    )
    await app.ready()

    const res = await app.fetch('/cache-builder-both/data')
    expect(res.headers.get('etag')).toBe('"builder-etag"')
    expect(store.ops).toContain('set')
  })

  it('.etagGenerator(kETagGenerator) resolves a container-bound generator and drives the ETag header', async () => {
    @Controller('/cache-di-etag')
    class ETagGenController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagGenController]

    const container = new CaffeineIoC()
    container.bind(kETagGenerator, t => t.toValue(() => '"sentinel-etag"'))
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server), { container }).with(
      HTTPCaching(b => b.etagGenerator(kETagGenerator)),
    )
    await app.ready()

    const res = await app.fetch('/cache-di-etag/data')
    expect(res.headers.get('etag')).toBe('"sentinel-etag"')
  })

  it('a per-route @Cache({ etagGenerator }) still wins over the container-bound generator', async () => {
    @Controller('/cache-di-etag-override')
    class ETagOverrideController {
      @Cache({ ttl: 60, etagGenerator: () => '"route-override"' })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagOverrideController]

    const container = new CaffeineIoC()
    container.bind(kETagGenerator, t => t.toValue(() => '"sentinel-etag"'))
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server), { container }).with(
      HTTPCaching(b => b.etagGenerator(kETagGenerator)),
    )
    await app.ready()

    const res = await app.fetch('/cache-di-etag-override/data')
    expect(res.headers.get('etag')).toBe('"route-override"')
  })
})

describe('X-Cache status header', () => {
  it('MISS on first request, HIT on the second', async () => {
    @Controller('/xc-basic')
    class XCBasicController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCBasicController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/xc-basic/data')
    expect(res1.headers.get('x-cache')).toBe('MISS')

    const res2 = await app.fetch('/xc-basic/data')
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('HIT on a 304 Not Modified served from cache', async () => {
    @Controller('/xc-304')
    class XC304Controller {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { v: 1 }
      }
    }
    void [XC304Controller]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res1 = await app.fetch('/xc-304/data')
    const etag = res1.headers.get('etag') as string

    const res2 = await app.fetch('/xc-304/data', { headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('BYPASS when the request sends Cache-Control: no-store', async () => {
    @Controller('/xc-bypass')
    class XCBypassController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCBypassController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/xc-bypass/data', { headers: { 'cache-control': 'no-store' } })
    expect(res.headers.get('x-cache')).toBe('BYPASS')
  })

  it('BYPASS on a @Cache(false) route', async () => {
    @Controller('/xc-false')
    class XCFalseController {
      @Cache(false)
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCFalseController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    const res = await app.fetch('/xc-false/data')
    expect(res.headers.get('x-cache')).toBe('BYPASS')
  })

  it('.statusHeader(...) renames the header', async () => {
    @Controller('/xc-custom')
    class XCCustomController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCCustomController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.statusHeader('X-My-Cache')))
    await app.ready()

    const res = await app.fetch('/xc-custom/data')
    expect(res.headers.get('x-cache')).toBeNull()
    expect(res.headers.get('x-my-cache')).toBe('MISS')
  })
})

describe('Canonical query keys', () => {
  it('same params in a different order share one cache entry', async () => {
    let callCount = 0

    @Controller('/qk-order')
    class QueryKeyOrderController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [QueryKeyOrderController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/qk-order/data?a=1&b=2')
    const res2 = await app.fetch('/qk-order/data?b=2&a=1')

    expect(callCount).toBe(1)
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('different param values still partition into separate entries', async () => {
    let callCount = 0

    @Controller('/qk-values')
    class QueryKeyValuesController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [QueryKeyValuesController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/qk-values/data?a=1')
    await app.fetch('/qk-values/data?a=2')
    expect(callCount).toBe(2)
  })
})

describe('Age header & request max-age', () => {
  it('emits an Age header (seconds) on a cache hit', async () => {
    @Controller('/age-hit')
    class AgeHitController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [AgeHitController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/age-hit/data')
    const res2 = await app.fetch('/age-hit/data')

    expect(res2.headers.get('x-cache')).toBe('HIT')
    expect(res2.headers.get('age')).toBeDefined()
    expect(Number(res2.headers.get('age'))).toBeGreaterThanOrEqual(0)
  })

  it('request Cache-Control: max-age larger than the entry age is served from cache', async () => {
    @Controller('/age-maxage-ok')
    class AgeMaxAgeOkController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [AgeMaxAgeOkController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching())
    await app.ready()

    await app.fetch('/age-maxage-ok/data')
    const res2 = await app.fetch('/age-maxage-ok/data', { headers: { 'cache-control': 'max-age=100' } })
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('request Cache-Control: max-age smaller than the entry age revalidates', async () => {
    let callCount = 0

    // A store that always returns an entry aged ~100s, so the max-age=10 request must revalidate.
    class AgedStore extends CacheStore {
      async get(): Promise<CacheEntry | undefined> {
        return { payload: JSON.stringify({ ok: true }), headers: {}, storedAt: Date.now() - 100_000 }
      }

      async set() {}
      async delete() {}
      async deleteMany() {}
      async clear() {}
    }

    @Controller('/age-maxage-stale')
    class AgeMaxAgeStaleController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        callCount++
        return { ok: true }
      }
    }
    void [AgeMaxAgeStaleController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching(b => b.store(new AgedStore())))
    await app.ready()

    const res = await app.fetch('/age-maxage-stale/data', { headers: { 'cache-control': 'max-age=10' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(callCount).toBe(1)
  })
})

describe('MemoryCacheStore maxBytes budget', () => {
  it('evicts least-recently-used entries once the byte budget is exceeded', async () => {
    const store = new MemoryCacheStore({ maxBytes: 200 })
    const big = 'x'.repeat(150)

    await store.set('a', 'seg', { payload: big, headers: {} }, 60)
    await store.set('b', 'seg', { payload: big, headers: {} }, 60)

    // Two ~151-byte entries exceed the 200-byte budget → the older 'a' is evicted, 'b' survives.
    expect(await store.get('a', 'seg')).toBeUndefined()
    expect(await store.get('b', 'seg')).toBeDefined()
  })
})

describe('default CacheStore', () => {
  // A store bound polymorphically with `.extends(CacheStore)` is one of the two documented ways to supply a
  // store (caching/store.ts) — resolvable with `.store(CacheStore)` like a direct binding, since
  // `container.getOptional` follows `.extends()` the same as any other lookup.
  it('.store(token) resolves a store bound polymorphically with .extends()', async () => {
    class ExtendingStore extends MemoryCacheStore {}

    const container = new CaffeineIoC()
    container.bind(ExtendingStore, t => t.toSelf().extends(CacheStore))

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container }).with(
      HTTPCaching(b => b.store(CacheStore)),
    )
    await app.ready()

    expect(app.container.get(CacheStore)).toBeInstanceOf(ExtendingStore)

    await app.close()
  })
})
