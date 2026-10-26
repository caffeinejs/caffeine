import { Readable } from 'node:stream'

import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, Get, Post, Status } from '@caffeinejs/http'
import { createWebApplication as newWebApplication } from '@caffeinejs/http/fastify'
import { Hour, Minute, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, it, expect, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, kETagGenerator, HTTPCaching } from '../index.js'
import type { HTTPCacheEntry, HTTPCacheStore } from '../index.js'

// Every application a case builds is closed after it, whether or not it got as far as `bootstrap()`.
const opened: { close(): Promise<unknown> }[] = []

function createWebApplication(options?: { container: CaffeineIoC }) {
  const app = newWebApplication(options)
  opened.push(app)

  return app
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(opened.splice(0).map(app => app.close()))
})

describe('Cache-Control headers', () => {
  describe('ttl', () => {
    it('@CacheControl({ ttl: 60 * Second }) → "public, max-age=60"', async () => {
      @Controller('/cache-cc-ttl-num')
      class TtlNumController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TtlNumController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-ttl-num/data')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    })

    it('@CacheControl({ ttl: "5m" }) → "public, max-age=300"', async () => {
      @Controller('/cache-cc-ttl-str-m')
      class TtlStrMController {
        @CacheControl({ ttl: 5 * Minute })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TtlStrMController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-ttl-str-m/data')
      expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    })

    it('@CacheControl({ ttl: "1h30m" }) → "public, max-age=5400"', async () => {
      @Controller('/cache-cc-ttl-compound')
      class TtlCompoundController {
        @CacheControl({ ttl: 90 * Minute })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TtlCompoundController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-ttl-compound/data')
      expect(res.headers.get('cache-control')).toBe('public, max-age=5400')
    })
  })

  describe('sharedMaxAge', () => {
    it('@CacheControl({ ttl: "5m", sharedMaxAge: "1h" }) → includes "s-maxage=3600"', async () => {
      @Controller('/cache-cc-smaxage')
      class SharedMaxAgeController {
        @CacheControl({ ttl: 5 * Minute, sharedMaxAge: 1 * Hour })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [SharedMaxAgeController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-smaxage/data')
      expect(res.headers.get('cache-control')).toContain('max-age=300')
      expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
    })
  })

  describe('stale directives', () => {
    it('@CacheControl({ ttl: 60 * Second, staleWhileRevalidate: 30 * Second }) → includes "stale-while-revalidate=30"', async () => {
      @Controller('/cache-cc-swr')
      class StaleWhileRevalidateController {
        @CacheControl({ ttl: 60 * Second, staleWhileRevalidate: 30 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [StaleWhileRevalidateController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-swr/data')
      expect(res.headers.get('cache-control')).toContain('stale-while-revalidate=30')
    })

    it('@CacheControl({ ttl: 60 * Second, staleIfError: "1h" }) → includes "stale-if-error=3600"', async () => {
      @Controller('/cache-cc-sie')
      class StaleIfErrorController {
        @CacheControl({ ttl: 60 * Second, staleIfError: 1 * Hour })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [StaleIfErrorController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-sie/data')
      expect(res.headers.get('cache-control')).toContain('stale-if-error=3600')
    })
  })

  describe('visibility', () => {
    it('@CacheControl({ ttl: 60 * Second, privacy: "private" }) → "private, max-age=60"', async () => {
      @Controller('/cache-cc-private')
      class PrivateCacheController {
        @CacheControl({ ttl: 60 * Second, privacy: 'private' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [PrivateCacheController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-private/data')
      expect(res.headers.get('cache-control')).toBe('private, max-age=60')
    })

    it('@CacheControl({ ttl: 60 * Second, privacy: "public" }) → "public, max-age=60"', async () => {
      @Controller('/cache-cc-public')
      class PublicCacheController {
        @CacheControl({ ttl: 60 * Second, privacy: 'public' })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [PublicCacheController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-public/data')
      expect(res.headers.get('cache-control')).toContain('public')
    })
  })

  describe('special directives', () => {
    it('@CacheControl({ noStore: true }) → "no-store"', async () => {
      @Controller('/cache-cc-nostore')
      class NoStoreController {
        @CacheControl({ noStore: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [NoStoreController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-nostore/data')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('@CacheControl({ noCache: true }) → "no-cache"', async () => {
      @Controller('/cache-cc-nocache')
      class NoCacheController {
        @CacheControl({ noCache: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [NoCacheController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-nocache/data')
      expect(res.headers.get('cache-control')).toContain('no-cache')
    })

    it('@CacheControl({ ttl: 60 * Second, mustRevalidate: true }) → includes "must-revalidate"', async () => {
      @Controller('/cache-cc-mustrevalidate')
      class MustRevalidateController {
        @CacheControl({ ttl: 60 * Second, mustRevalidate: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [MustRevalidateController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-mustrevalidate/data')
      expect(res.headers.get('cache-control')).toContain('must-revalidate')
    })

    it('@CacheControl({ ttl: 60 * Second, immutable: true }) → includes "immutable"', async () => {
      @Controller('/cache-cc-immutable')
      class ImmutableController {
        @CacheControl({ ttl: 60 * Second, immutable: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ImmutableController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-cc-immutable/data')
      expect(res.headers.get('cache-control')).toContain('immutable')
    })
  })

  it('@CacheControl() with no options → no Cache-Control header', async () => {
    @Controller('/cache-cc-empty')
    class EmptyOptionsController {
      @CacheControl()
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [EmptyOptionsController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-cc-empty/data')
    expect(res.headers.get('cache-control')).toBeNull()
  })
})

describe('Vary header', () => {
  it('@CacheControl({ vary: ["Accept-Language"] }) → "Vary: Accept-Language"', async () => {
    @Controller('/cache-vary-single')
    class VarySingleController {
      @CacheControl({ vary: ['Accept-Language'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VarySingleController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-vary-single/data')
    expect(res.headers.get('vary')).toBe('Accept-Language')
  })

  it('@CacheControl({ vary: ["Accept", "Accept-Encoding"] }) → "Vary: Accept, Accept-Encoding"', async () => {
    @Controller('/cache-vary-multi')
    class VaryMultiController {
      @CacheControl({ vary: ['Accept', 'Accept-Encoding'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VaryMultiController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-vary-multi/data')
    expect(res.headers.get('vary')).toBe('Accept, Accept-Encoding')
  })

  it('no vary option → no Vary header', async () => {
    @Controller('/cache-vary-none')
    class VaryNoneController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VaryNoneController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-vary-none/data')
    expect(res.headers.get('vary')).toBeNull()
  })
})

describe('ETag', () => {
  it('@CacheControl({ ttl: 60 * Second }) → ETag header present in double-quoted format', async () => {
    @Controller('/cache-etag-present')
    class ETagPresentController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagPresentController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-etag-present/data')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toMatch(/^"[^"]+"$/)
  })

  it('same response body on two requests → same ETag', async () => {
    @Controller('/cache-etag-stable')
    class ETagStableController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { value: 'constant' }
      }
    }
    void [ETagStableController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/cache-etag-stable/data')
    const res2 = await app.request('/cache-etag-stable/data')

    expect(res1.headers.get('etag')).toBe(res2.headers.get('etag'))
  })

  it('different response bodies → different ETags', async () => {
    @Controller('/cache-etag-diff')
    class ETagDiffController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/a')
      a() {
        return { label: 'alpha' }
      }

      @CacheControl({ ttl: 60 * Second })
      @Get('/b')
      b() {
        return { label: 'beta' }
      }
    }
    void [ETagDiffController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const resA = await app.request('/cache-etag-diff/a')
    const resB = await app.request('/cache-etag-diff/b')

    expect(resA.headers.get('etag')).toMatch(/^"[^"]+"$/)
    expect(resB.headers.get('etag')).toMatch(/^"[^"]+"$/)
    expect(resA.headers.get('etag')).not.toBe(resB.headers.get('etag'))
  })

  it('@CacheControl({ etag: false }) → no ETag header', async () => {
    @Controller('/cache-etag-disabled')
    class ETagDisabledController {
      @CacheControl({ ttl: 60 * Second, etag: false })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagDisabledController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-etag-disabled/data')
    expect(res.headers.get('etag')).toBeNull()
  })

  it('@CacheControl({ noStore: true }) → no ETag header', async () => {
    @Controller('/cache-etag-nostore')
    class ETagNoStoreController {
      @CacheControl({ noStore: true })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagNoStoreController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-etag-nostore/data')
    expect(res.headers.get('etag')).toBeNull()
  })

  it('stream response body → no ETag (cannot hash a stream)', async () => {
    @Controller('/cache-etag-stream')
    class ETagStreamController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return Readable.from(['hello', ' ', 'world'])
      }
    }
    void [ETagStreamController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-etag-stream/data')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeNull()
  })
})

describe('304 Not Modified', () => {
  it('GET with matching If-None-Match → 304, empty body', async () => {
    @Controller('/cache-304-match')
    class Match304Controller {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { value: 'cached' }
      }
    }
    void [Match304Controller]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/cache-304-match/data')
    const etag = res1.headers.get('etag') as string
    expect(etag).not.toBeNull()

    const res2 = await app.request('/cache-304-match/data', { headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)
    expect(await res2.text()).toBe('')
  })

  it('GET with non-matching If-None-Match → 200, full body', async () => {
    @Controller('/cache-304-nomatch')
    class NoMatch304Controller {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { value: 'cached' }
      }
    }
    void [NoMatch304Controller]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-304-nomatch/data')

    const res = await app.request('/cache-304-nomatch/data', { headers: { 'if-none-match': '"stale-etag-value"' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: 'cached' })
  })

  it('GET with stale If-None-Match after a tag eviction → 200, new ETag', async () => {
    let version = 1

    @Controller('/cache-304-stale')
    class Stale304Controller {
      @CacheControl({ ttl: 60 * Second, tags: ['forgotten'] })
      @Get('/data')
      data() {
        return { version }
      }
    }
    void [Stale304Controller]

    const store = new MemoryHTTPCacheStore()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store)))
    await app.bootstrap()

    const res1 = await app.request('/cache-304-stale/data')
    const oldEtag = res1.headers.get('etag') as string

    version = 2
    await store.evictByTag('forgotten')

    const res2 = await app.request('/cache-304-stale/data', { headers: { 'if-none-match': oldEtag } })
    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual({ version: 2 })
    expect(res2.headers.get('etag')).not.toBe(oldEtag)
  })

  // The store forgetting an entry does not change the resource. A client revalidating the copy it holds is told
  // it is still current, from the response the handler just produced.
  it('GET with a still-matching If-None-Match after a tag eviction → 304 off the fresh response', async () => {
    @Controller('/cache-304-fresh')
    class Fresh304Controller {
      @CacheControl({ ttl: 60 * Second, tags: ['forgotten'] })
      @Get('/data')
      data() {
        return { value: 'content' }
      }
    }
    void [Fresh304Controller]

    const store = new MemoryHTTPCacheStore()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store)))
    await app.bootstrap()

    const etag = (await app.request('/cache-304-fresh/data')).headers.get('etag') as string
    await store.evictByTag('forgotten')

    const res = await app.request('/cache-304-fresh/data', { headers: { 'if-none-match': etag } })
    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    expect(res.headers.get('x-cache')).toBe('MISS')

    // It was stored on the way out all the same: the next plain request is a hit with the body.
    const hit = await app.request('/cache-304-fresh/data')
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(await hit.json()).toEqual({ value: 'content' })
  })

  // An ETag nobody compares is a hash computed for nothing: a route with no ttl still answers a revalidation.
  it('@CacheControl() with no ttl → 304 for a matching If-None-Match', async () => {
    @Controller('/cache-304-etag-only')
    class ETagOnly304Controller {
      @CacheControl()
      @Get('/data')
      data() {
        return { same: true }
      }
    }
    void [ETagOnly304Controller]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const etag = (await app.request('/cache-304-etag-only/data')).headers.get('etag') as string
    const res = await app.request('/cache-304-etag-only/data', { headers: { 'if-none-match': etag } })

    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
  })

  it('HEAD with matching If-None-Match → 304', async () => {
    @Controller('/cache-304-head')
    class Head304Controller {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { value: 'head-cached' }
      }
    }
    void [Head304Controller]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/cache-304-head/data')
    const etag = res1.headers.get('etag') as string

    const res2 = await app.request('/cache-304-head/data', { method: 'HEAD', headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)
  })
})

describe('Cache store', () => {
  it('first request calls handler; second request served from cache', async () => {
    let callCount = 0

    @Controller('/cache-store-bypass')
    class StoreBupassController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StoreBupassController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/cache-store-bypass/data')
    expect(callCount).toBe(1)
    expect(await res1.json()).toEqual({ count: 1 })

    const res2 = await app.request('/cache-store-bypass/data')
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
  })

  it('@CacheControl({ noStore: true }) always calls handler', async () => {
    let callCount = 0

    @Controller('/cache-store-nostore')
    class StoreNoStoreController {
      @CacheControl({ noStore: true })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StoreNoStoreController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-store-nostore/data')
    await app.request('/cache-store-nostore/data')
    expect(callCount).toBe(2)
  })

  it('POST not cached by default methods', async () => {
    let callCount = 0

    @Controller('/cache-store-post-default')
    class StorePostDefaultController {
      @CacheControl({ ttl: 60 * Second })
      @Post('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StorePostDefaultController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-store-post-default/data', { method: 'POST' })
    await app.request('/cache-store-post-default/data', { method: 'POST' })
    expect(callCount).toBe(2)
  })

  it('@CacheControl({ methods: ["GET", "POST"] }) caches POST responses', async () => {
    let callCount = 0

    @Controller('/cache-store-post-custom')
    class StorePostCustomController {
      @CacheControl({ ttl: 60 * Second, methods: ['GET', 'POST'] })
      @Post('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StorePostCustomController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/cache-store-post-custom/data', { method: 'POST' })
    expect(callCount).toBe(1)
    expect(await res1.json()).toEqual({ count: 1 })

    const res2 = await app.request('/cache-store-post-custom/data', { method: 'POST' })
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
  })

  it('@CacheControl({ statusCodes: [200, 201] }) caches 201 but not 400', async () => {
    let createdCount = 0
    let errCount = 0

    @Controller('/cache-store-status')
    class StoreStatusController {
      @CacheControl({ ttl: 60 * Second, statusCodes: [200, 201] })
      @Status(201)
      @Get('/created')
      created() {
        createdCount++
        return { n: createdCount }
      }

      @CacheControl({ ttl: 60 * Second, statusCodes: [200, 201] })
      @Status(400)
      @Get('/err')
      err() {
        errCount++
        return { n: errCount }
      }
    }
    void [StoreStatusController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-store-status/created')
    const replayed = await app.request('/cache-store-status/created')
    expect(createdCount).toBe(1)
    expect(replayed.headers.get('x-cache')).toBe('HIT')
    // Served from the store as what it was: a 201, not a 200 carrying a 201's body.
    expect(replayed.status).toBe(201)

    await app.request('/cache-store-status/err')
    const again = await app.request('/cache-store-status/err')
    expect(errCount).toBe(2)
    expect(again.status).toBe(400)
    expect(again.headers.get('x-cache')).toBe('MISS')
  })

  it('after the tag is evicted, handler is called again', async () => {
    let callCount = 0

    @Controller('/cache-store-clear')
    class StoreClearController {
      @CacheControl({ ttl: 60 * Second, tags: ['forgotten'] })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [StoreClearController]

    const store = new MemoryHTTPCacheStore()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store)))
    await app.bootstrap()

    await app.request('/cache-store-clear/data')
    expect(callCount).toBe(1)

    await app.request('/cache-store-clear/data')
    expect(callCount).toBe(1)

    await store.evictByTag('forgotten')

    await app.request('/cache-store-clear/data')
    expect(callCount).toBe(2)
  })
})

describe('Cache key', () => {
  it('different URLs are cached independently', async () => {
    let aCount = 0
    let bCount = 0

    @Controller('/cache-key-urls')
    class KeyURLsController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/a')
      a() {
        aCount++
        return { n: aCount }
      }

      @CacheControl({ ttl: 60 * Second })
      @Get('/b')
      b() {
        bCount++
        return { n: bCount }
      }
    }
    void [KeyURLsController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-key-urls/a')
    await app.request('/cache-key-urls/a')
    await app.request('/cache-key-urls/b')
    await app.request('/cache-key-urls/b')

    expect(aCount).toBe(1)
    expect(bCount).toBe(1)
  })

  it('custom key fn ignores query string when key is based on pathname only', async () => {
    let callCount = 0

    @Controller('/cache-key-custom-path')
    class KeyCustomPathController {
      @CacheControl({ ttl: 60 * Second, key: req => req.url.split('?')[0] })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [KeyCustomPathController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-key-custom-path/data?v=1')
    await app.request('/cache-key-custom-path/data?v=2')
    expect(callCount).toBe(1)
  })

  it('custom key fn using query param creates separate cache entries', async () => {
    let callCount = 0

    @Controller('/cache-key-custom-query')
    class KeyCustomQueryController {
      @CacheControl({ ttl: 60 * Second, key: req => `${req.url}?lang=${req.query('lang') ?? ''}` })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [KeyCustomQueryController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-key-custom-query/data?lang=en')
    await app.request('/cache-key-custom-query/data?lang=pt')
    expect(callCount).toBe(2)

    await app.request('/cache-key-custom-query/data?lang=en')
    await app.request('/cache-key-custom-query/data?lang=pt')
    expect(callCount).toBe(2)
  })
})

describe('Decorator scope', () => {
  it('class-level @CacheControl applies to all routes on controller', async () => {
    @CacheControl({ ttl: 60 * Second })
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

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const resA = await app.request('/cache-scope-class/a')
    const resB = await app.request('/cache-scope-class/b')

    expect(resA.headers.get('cache-control')).toBe('public, max-age=60')
    expect(resB.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('route-level @CacheControl applies only to the decorated method', async () => {
    @Controller('/cache-scope-method')
    class ScopeMethodController {
      @CacheControl({ ttl: 60 * Second })
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

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const resCached = await app.request('/cache-scope-method/cached')
    const resUncached = await app.request('/cache-scope-method/uncached')

    expect(resCached.headers.get('cache-control')).toBe('public, max-age=60')
    expect(resUncached.headers.get('cache-control')).toBeNull()
  })

  it('route-level @CacheControl completely replaces router-level @CacheControl (no partial merge)', async () => {
    @CacheControl({ ttl: 60 * Second, privacy: 'private' })
    @Controller('/cache-scope-replace')
    class ScopeReplaceController {
      @CacheControl({ ttl: 30 * Second })
      @Get('/route')
      route() {
        return { ok: true }
      }
    }
    void [ScopeReplaceController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-scope-replace/route')
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
    expect(res.headers.get('cache-control')).not.toContain('private')
  })
})

describe('Undecorated routes', () => {
  it('route without @CacheControl → no Cache-Control, no ETag, no caching', async () => {
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

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/cache-undecorated/data')
    await app.request('/cache-undecorated/data')

    expect(res1.headers.get('cache-control')).toBeNull()
    expect(res1.headers.get('etag')).toBeNull()
    expect(callCount).toBe(2)
  })
})

describe('@CacheControl(false)', () => {
  it('method-level @CacheControl(false) → all four no-cache headers on every response', async () => {
    @Controller('/cache-false-method')
    class CacheFalseMethodController {
      @CacheControl(false)
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [CacheFalseMethodController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/cache-false-method/data')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(res.headers.get('expires')).toBe('0')
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(res.headers.get('surrogate-control')).toBe('no-store')
  })

  it('class-level @CacheControl(false) → all routes in controller get no-cache headers', async () => {
    @CacheControl(false)
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

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const resA = await app.request('/cache-false-class/a')
    const resB = await app.request('/cache-false-class/b')

    expect(resA.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(resB.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
  })

  it('@CacheControl(false) → handler called on every request (never served from cache)', async () => {
    let callCount = 0

    @Controller('/cache-false-nocache')
    class CacheFalseNoCacheController {
      @CacheControl(false)
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [CacheFalseNoCacheController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/cache-false-nocache/data')
    await app.request('/cache-false-nocache/data')
    await app.request('/cache-false-nocache/data')
    expect(callCount).toBe(3)
  })
})

describe('the policy at the edges of RFC 9110 and RFC 9111', () => {
  describe('etag: false', () => {
    it('@CacheControl({ ttl: 60 * Second, etag: false }) → no ETag header, but second request served from cache', async () => {
      let callCount = 0

      @Controller('/cache-bug1-etag-false')
      class Bug1EtagFalseController {
        @CacheControl({ ttl: 60 * Second, etag: false })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug1EtagFalseController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-bug1-etag-false/data')
      expect(res1.status).toBe(200)
      expect(res1.headers.get('etag')).toBeNull()
      expect(callCount).toBe(1)

      const res2 = await app.request('/cache-bug1-etag-false/data')
      expect(res2.status).toBe(200)
      expect(await res2.json()).toEqual({ count: 1 })
      expect(callCount).toBe(1)
    })

    it('@CacheControl({ ttl: 60 * Second, etag: false }) + If-None-Match → 200 (no ETag to match against)', async () => {
      @Controller('/cache-bug1-inm-ignored')
      class Bug1InmIgnoredController {
        @CacheControl({ ttl: 60 * Second, etag: false })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [Bug1InmIgnoredController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-bug1-inm-ignored/data')

      const res = await app.request('/cache-bug1-inm-ignored/data', { headers: { 'if-none-match': '"some-etag"' } })
      expect(res.status).toBe(200)
    })
  })

  describe('privacy: private', () => {
    it('@CacheControl({ ttl: 60 * Second, privacy: "private" }) → Cache-Control: private, handler called on every request', async () => {
      let callCount = 0

      @Controller('/cache-bug2-private')
      class Bug2PrivateController {
        @CacheControl({ ttl: 60 * Second, privacy: 'private' })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug2PrivateController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-bug2-private/data')
      expect(res1.headers.get('cache-control')).toContain('private')
      expect(callCount).toBe(1)

      const res2 = await app.request('/cache-bug2-private/data')
      expect(await res2.json()).toEqual({ count: 2 })
      expect(callCount).toBe(2)
    })
  })

  describe('the request headers a route varies on', () => {
    it('same URL, different Vary header value → separate cache entries', async () => {
      let callCount = 0

      @Controller('/cache-bug3-vary-separate')
      class Bug3VarySeparateController {
        @CacheControl({ ttl: 60 * Second, vary: ['Accept-Language'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug3VarySeparateController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-bug3-vary-separate/data', { headers: { 'accept-language': 'en-US' } })
      await app.request('/cache-bug3-vary-separate/data', { headers: { 'accept-language': 'pt-BR' } })
      expect(callCount).toBe(2)
    })

    it('same URL, same Vary header value → second request served from cache', async () => {
      let callCount = 0

      @Controller('/cache-bug3-vary-hit')
      class Bug3VaryHitController {
        @CacheControl({ ttl: 60 * Second, vary: ['Accept-Language'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug3VaryHitController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-bug3-vary-hit/data', { headers: { 'accept-language': 'en-US' } })
      await app.request('/cache-bug3-vary-hit/data', { headers: { 'accept-language': 'en-US' } })
      expect(callCount).toBe(1)
    })

    it('Vary on multiple headers — all values combined into key', async () => {
      let callCount = 0

      @Controller('/cache-bug3-vary-multi')
      class Bug3VaryMultiController {
        @CacheControl({ ttl: 60 * Second, vary: ['Accept-Language', 'Accept'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug3VaryMultiController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      // same Accept-Language, different Accept → separate entry
      await app.request('/cache-bug3-vary-multi/data', {
        headers: { 'accept-language': 'en', accept: 'application/json' },
      })
      await app.request('/cache-bug3-vary-multi/data', { headers: { 'accept-language': 'en', accept: 'text/html' } })
      expect(callCount).toBe(2)

      // exact same headers → cache hit
      await app.request('/cache-bug3-vary-multi/data', {
        headers: { 'accept-language': 'en', accept: 'application/json' },
      })
      expect(callCount).toBe(2)
    })
  })

  describe('a request that says no-cache', () => {
    it('GET with Cache-Control: no-cache after cache is primed → handler called again', async () => {
      let callCount = 0

      @Controller('/cache-bug4-cc-nocache')
      class Bug4CCNoCacheController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug4CCNoCacheController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-bug4-cc-nocache/data')
      expect(callCount).toBe(1)

      // Second request — normally would be cached
      await app.request('/cache-bug4-cc-nocache/data')
      expect(callCount).toBe(1)

      // Third request with no-cache — must bypass cache
      const res = await app.request('/cache-bug4-cc-nocache/data', { headers: { 'cache-control': 'no-cache' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })

    it('GET with Pragma: no-cache → handler called again (HTTP/1.0 compat)', async () => {
      let callCount = 0

      @Controller('/cache-bug4-pragma')
      class Bug4PragmaController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [Bug4PragmaController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-bug4-pragma/data')
      expect(callCount).toBe(1)

      const res = await app.request('/cache-bug4-pragma/data', { headers: { pragma: 'no-cache' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('Vary: *', () => {
    it('@CacheControl({ ttl: 60 * Second, vary: ["*"] }) → handler called on every request, Vary: * header set', async () => {
      let callCount = 0

      @Controller('/cache-vary-star')
      class VaryStarController {
        @CacheControl({ ttl: 60 * Second, vary: ['*'] })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [VaryStarController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-vary-star/data')
      expect(res1.status).toBe(200)
      expect(res1.headers.get('vary')).toBe('*')
      expect(callCount).toBe(1)

      const res2 = await app.request('/cache-vary-star/data')
      expect(res2.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('Cache tags', () => {
    it('stores under the route tags, and hints them to the store on a read', async () => {
      class SpyStore implements HTTPCacheStore {
        readonly hinted: (readonly string[] | undefined)[] = []
        readonly stored: (readonly string[] | undefined)[] = []
        async get(_key: string, options?: { tags?: readonly string[] }) {
          this.hinted.push(options?.tags)
          return undefined
        }

        async put(_key: string, _entry: HTTPCacheEntry, options: { tags?: readonly string[] }) {
          this.stored.push(options.tags)
        }

        async evictByTag() {}
      }
      const spyStore = new SpyStore()

      @Controller('/cache-tags')
      class TagsController {
        @CacheControl({ ttl: 60 * Second, tags: ['products', 'all'] })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [TagsController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(spyStore)))
      await app.bootstrap()

      await app.request('/cache-tags/data')
      expect(spyStore.hinted).toEqual([['products', 'all']])
      expect(spyStore.stored).toEqual([['products', 'all']])
    })
  })

  describe('Authorization header → private by default (RFC 9111 §3.5)', () => {
    it('Authorization present without privacy override → Cache-Control: private, not stored', async () => {
      let callCount = 0

      @Controller('/cache-auth-private')
      class AuthPrivateController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [AuthPrivateController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-auth-private/data', { headers: { authorization: 'Bearer token123' } })
      expect(res1.status).toBe(200)
      expect(res1.headers.get('cache-control')).toContain('private')
      expect(callCount).toBe(1)

      // Second request — must not be served from cache
      const res2 = await app.request('/cache-auth-private/data', { headers: { authorization: 'Bearer token123' } })
      expect(res2.status).toBe(200)
      expect(callCount).toBe(2)
    })

    it('Authorization present with privacy: public override → stored and served from cache', async () => {
      let callCount = 0

      @Controller('/cache-auth-public-override')
      class AuthPublicOverrideController {
        @CacheControl({ ttl: 60 * Second, privacy: 'public' })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [AuthPublicOverrideController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-auth-public-override/data', { headers: { authorization: 'Bearer token123' } })
      expect(callCount).toBe(1)

      const res2 = await app.request('/cache-auth-public-override/data', {
        headers: { authorization: 'Bearer token123' },
      })
      expect(res2.status).toBe(200)
      expect(callCount).toBe(1)
    })
  })

  describe('the store key', () => {
    // One derivation: the read and the write of a request agree on its key. A brace would form a Redis hash tag,
    // letting a request choose the cluster slot its entry lands on, and whitespace is refused by some backends.
    it('is the same for the read and the write, and carries no brace or whitespace from the request', async () => {
      class SpyStore implements HTTPCacheStore {
        readonly keySeen: string[] = []
        async get(key: string) {
          this.keySeen.push(key)
          return undefined
        }

        async put(key: string) {
          this.keySeen.push(key)
        }

        async evictByTag() {}
      }
      const spyStore = new SpyStore()
      const keySeen = spyStore.keySeen

      @Controller('/cache-key-encode')
      class KeyEncodeController {
        @CacheControl({ ttl: 60 * Second, vary: ['X-Tenant'] })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [KeyEncodeController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(spyStore)))
      await app.bootstrap()

      await app.request('/cache-key-encode/data?a=1', { headers: { 'x-tenant': '{acme corp}' } })

      expect(keySeen).toHaveLength(2)
      expect(keySeen[1]).toBe(keySeen[0])
      expect(keySeen[0]).not.toMatch(/[{}\s]/)
    })
  })

  describe('Request no-store bypass (RFC 9111 §5.2.1.5)', () => {
    it('Cache-Control: no-store in request → handler called again, not served from cache', async () => {
      let callCount = 0

      @Controller('/cache-req-nostore')
      class ReqNoStoreController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [ReqNoStoreController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-req-nostore/data')
      expect(callCount).toBe(1)

      // Second request normally would be cached
      await app.request('/cache-req-nostore/data')
      expect(callCount).toBe(1)

      // Third request with no-store must bypass cache
      const res = await app.request('/cache-req-nostore/data', { headers: { 'cache-control': 'no-store' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })

  describe('If-None-Match: wildcard and comma-separated (RFC 9110 §13.1.2)', () => {
    it('If-None-Match: * → 304 when any cached response exists', async () => {
      @Controller('/cache-inm-wildcard')
      class InmWildcardController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { v: 1 }
        }
      }
      void [InmWildcardController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-inm-wildcard/data')

      const res = await app.request('/cache-inm-wildcard/data', { headers: { 'if-none-match': '*' } })
      expect(res.status).toBe(304)
    })

    it('If-None-Match comma-separated list → 304 when one entry matches', async () => {
      @Controller('/cache-inm-list')
      class InmListController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { v: 1 }
        }
      }
      void [InmListController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-inm-list/data')
      const etag = res1.headers.get('etag') as string

      const res = await app.request('/cache-inm-list/data', {
        headers: { 'if-none-match': `"stale-one", ${etag}, "stale-two"` },
      })
      expect(res.status).toBe(304)
    })

    it('If-None-Match weak ETag W/"xxx" matches strong "xxx"', async () => {
      @Controller('/cache-inm-weak')
      class InmWeakController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { v: 1 }
        }
      }
      void [InmWeakController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-inm-weak/data')
      const strongEtag = res1.headers.get('etag') as string
      expect(strongEtag).toMatch(/^"[^"]+"$/)

      const weakEtag = `W/${strongEtag}`
      const res = await app.request('/cache-inm-weak/data', { headers: { 'if-none-match': weakEtag } })
      expect(res.status).toBe(304)
    })
  })

  describe('proxyRevalidate option (RFC 9111 §5.2.2.8)', () => {
    it('@CacheControl({ ttl: 60 * Second, proxyRevalidate: true }) → Cache-Control includes proxy-revalidate', async () => {
      @Controller('/cache-proxy-revalidate')
      class ProxyRevalidateController {
        @CacheControl({ ttl: 60 * Second, proxyRevalidate: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ProxyRevalidateController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-proxy-revalidate/data')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('proxy-revalidate')
    })
  })

  describe('only-if-cached request directive (RFC 9111 §5.2.1.7)', () => {
    it('cache miss + only-if-cached → 504', async () => {
      @Controller('/cache-only-if-cached-miss')
      class OnlyIfCachedMissController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [OnlyIfCachedMissController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-only-if-cached-miss/data', {
        headers: { 'cache-control': 'only-if-cached' },
      })
      expect(res.status).toBe(504)
    })

    it('cache hit + only-if-cached → 200 served from cache', async () => {
      let callCount = 0

      @Controller('/cache-only-if-cached-hit')
      class OnlyIfCachedHitController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [OnlyIfCachedHitController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-only-if-cached-hit/data')
      expect(callCount).toBe(1)

      const res = await app.request('/cache-only-if-cached-hit/data', {
        headers: { 'cache-control': 'only-if-cached' },
      })
      expect(res.status).toBe(200)
      expect(callCount).toBe(1)
    })
  })

  describe('no-transform directive (RFC 9111 §5.2.2.6)', () => {
    it('@CacheControl({ ttl: 60 * Second, noTransform: true }) → Cache-Control includes no-transform', async () => {
      @Controller('/cache-no-transform')
      class NoTransformController {
        @CacheControl({ ttl: 60 * Second, noTransform: true })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [NoTransformController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-no-transform/data')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-transform')
    })
  })

  describe('Last-Modified / If-Modified-Since (RFC 9110 §8.8.2, §13.1.3, §13.2.2)', () => {
    it('cached response includes a Last-Modified header', async () => {
      @Controller('/cache-last-modified')
      class LastModifiedController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [LastModifiedController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res = await app.request('/cache-last-modified/data')
      expect(Number.isNaN(Date.parse(res.headers.get('last-modified') ?? ''))).toBe(false)
    })

    it('If-Modified-Since at or after Last-Modified → 304', async () => {
      @Controller('/cache-ims-match')
      class ImsMatchController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ImsMatchController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      const res1 = await app.request('/cache-ims-match/data')
      const lastModified = res1.headers.get('last-modified') as string
      expect(lastModified).not.toBeNull()

      const res2 = await app.request('/cache-ims-match/data', { headers: { 'if-modified-since': lastModified } })
      expect(res2.status).toBe(304)
      expect(res2.headers.get('cache-control')).toBe('public, max-age=60')
    })

    it('If-Modified-Since before Last-Modified → 200 with full body', async () => {
      @Controller('/cache-ims-stale')
      class ImsStaleController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [ImsStaleController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-ims-stale/data')

      const res = await app.request('/cache-ims-stale/data', {
        headers: { 'if-modified-since': new Date(Date.now() - 60_000).toUTCString() },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    it('If-None-Match takes precedence over If-Modified-Since when both are present', async () => {
      @Controller('/cache-inm-precedence')
      class InmPrecedenceController {
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          return { ok: true }
        }
      }
      void [InmPrecedenceController]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-inm-precedence/data')

      // The If-Modified-Since alone would yield a 304: it is later than the response. The non-matching
      // If-None-Match is the one evaluated, and the answer is the full response.
      const res = await app.request('/cache-inm-precedence/data', {
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
        @CacheControl({ ttl: 60 * Second })
        @Get('/data')
        data() {
          callCount++
          return { count: callCount }
        }
      }
      void [ReqMaxAge0Controller]

      const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      await app.bootstrap()

      await app.request('/cache-req-maxage0/data')
      expect(callCount).toBe(1)

      const res = await app.request('/cache-req-maxage0/data', { headers: { 'cache-control': 'max-age=0' } })
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })
  })
})

describe('CacheControl builder & container-managed store', () => {
  // A Map-backed store, so the store a configuration names is seen to answer the requests.
  class MapStore implements HTTPCacheStore {
    readonly ops: string[] = []
    readonly #entries = new Map<string, HTTPCacheEntry>()

    async get(key: string): Promise<HTTPCacheEntry | undefined> {
      this.ops.push('get')
      return this.#entries.get(key)
    }

    async put(key: string, entry: HTTPCacheEntry): Promise<void> {
      this.ops.push('put')
      this.#entries.set(key, entry)
    }

    async evictByTag(): Promise<void> {
      this.#entries.clear()
    }
  }

  it('.store(token) resolves a container-bound store and backs caching', async () => {
    let callCount = 0

    @Controller('/cache-di-custom-store')
    class CustomStoreController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        callCount++
        return { count: callCount }
      }
    }
    void [CustomStoreController]

    const container = new CaffeineIoC()
    container.bind(MapStore, t => t.toClass(MapStore))
    const app = createWebApplication({ container }).with(HTTPCaching(b => b.store(MapStore)))
    await app.bootstrap()

    await app.request('/cache-di-custom-store/data')
    const res2 = await app.request('/cache-di-custom-store/data')

    const resolved = app.container.get(MapStore) as MapStore
    expect(resolved.ops).toContain('put')
    expect(resolved.ops).toContain('get')
    // Second request served from the custom store — handler ran only once.
    expect(callCount).toBe(1)
    expect(await res2.json()).toEqual({ count: 1 })
  })

  it('.store(instance).etagGenerator(...) applies both', async () => {
    @Controller('/cache-builder-both')
    class BuilderBothController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [BuilderBothController]

    const store = new MapStore()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store).etagGenerator(() => '"builder-etag"')))
    await app.bootstrap()

    const res = await app.request('/cache-builder-both/data')
    expect(res.headers.get('etag')).toBe('"builder-etag"')
    expect(store.ops).toContain('put')
  })

  it('.etagGenerator(kETagGenerator) resolves a container-bound generator and drives the ETag header', async () => {
    @Controller('/cache-di-etag')
    class ETagGenController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagGenController]

    const container = new CaffeineIoC()
    container.bind(kETagGenerator, t => t.toValue(() => '"sentinel-etag"'))
    const app = createWebApplication({ container }).with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).etagGenerator(kETagGenerator)),
    )
    await app.bootstrap()

    const res = await app.request('/cache-di-etag/data')
    expect(res.headers.get('etag')).toBe('"sentinel-etag"')
  })

  it('a per-route @CacheControl({ etagGenerator }) still wins over the container-bound generator', async () => {
    @Controller('/cache-di-etag-override')
    class ETagOverrideController {
      @CacheControl({ ttl: 60 * Second, etagGenerator: () => '"route-override"' })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ETagOverrideController]

    const container = new CaffeineIoC()
    container.bind(kETagGenerator, t => t.toValue(() => '"sentinel-etag"'))
    const app = createWebApplication({ container }).with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).etagGenerator(kETagGenerator)),
    )
    await app.bootstrap()

    const res = await app.request('/cache-di-etag-override/data')
    expect(res.headers.get('etag')).toBe('"route-override"')
  })
})

describe('X-Cache status header', () => {
  it('MISS on first request, HIT on the second', async () => {
    @Controller('/xc-basic')
    class XCBasicController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCBasicController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/xc-basic/data')
    expect(res1.headers.get('x-cache')).toBe('MISS')

    const res2 = await app.request('/xc-basic/data')
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('HIT on a 304 Not Modified served from cache', async () => {
    @Controller('/xc-304')
    class XC304Controller {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { v: 1 }
      }
    }
    void [XC304Controller]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res1 = await app.request('/xc-304/data')
    const etag = res1.headers.get('etag') as string

    const res2 = await app.request('/xc-304/data', { headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('BYPASS when the request sends Cache-Control: no-store', async () => {
    @Controller('/xc-bypass')
    class XCBypassController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCBypassController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/xc-bypass/data', { headers: { 'cache-control': 'no-store' } })
    expect(res.headers.get('x-cache')).toBe('BYPASS')
  })

  it('BYPASS on a @CacheControl(false) route', async () => {
    @Controller('/xc-false')
    class XCFalseController {
      @CacheControl(false)
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [XCFalseController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    const res = await app.request('/xc-false/data')
    expect(res.headers.get('x-cache')).toBe('BYPASS')
  })
})

describe('Canonical query keys', () => {
  it('same params in a different order share one cache entry', async () => {
    let callCount = 0

    @Controller('/qk-order')
    class QueryKeyOrderController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [QueryKeyOrderController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/qk-order/data?a=1&b=2')
    const res2 = await app.request('/qk-order/data?b=2&a=1')

    expect(callCount).toBe(1)
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('different param values still partition into separate entries', async () => {
    let callCount = 0

    @Controller('/qk-values')
    class QueryKeyValuesController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        callCount++
        return { n: callCount }
      }
    }
    void [QueryKeyValuesController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/qk-values/data?a=1')
    await app.request('/qk-values/data?a=2')
    expect(callCount).toBe(2)
  })
})

describe('Age header & request max-age', () => {
  it('emits an Age header (seconds) on a cache hit', async () => {
    @Controller('/age-hit')
    class AgeHitController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [AgeHitController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()
    vi.useFakeTimers({ toFake: ['Date'] })

    await app.request('/age-hit/data')
    vi.setSystemTime(Date.now() + 3000)
    const res2 = await app.request('/age-hit/data')

    expect(res2.headers.get('x-cache')).toBe('HIT')
    expect(res2.headers.get('age')).toBe('3')
  })

  it('request Cache-Control: max-age larger than the entry age is served from cache', async () => {
    @Controller('/age-maxage-ok')
    class AgeMaxAgeOkController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [AgeMaxAgeOkController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.bootstrap()

    await app.request('/age-maxage-ok/data')
    const res2 = await app.request('/age-maxage-ok/data', { headers: { 'cache-control': 'max-age=100' } })
    expect(res2.headers.get('x-cache')).toBe('HIT')
  })

  it('request Cache-Control: max-age smaller than the entry age revalidates', async () => {
    let callCount = 0

    // A store that always returns an entry aged ~100s, so the max-age=10 request must revalidate.
    class AgedStore implements HTTPCacheStore {
      async get(): Promise<HTTPCacheEntry | undefined> {
        return { payload: JSON.stringify({ ok: true }), statusCode: 200, headers: {}, storedAt: Date.now() - 100_000 }
      }

      async put() {}
      async evictByTag() {}
    }

    @Controller('/age-maxage-stale')
    class AgeMaxAgeStaleController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        callCount++
        return { ok: true }
      }
    }
    void [AgeMaxAgeStaleController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new AgedStore())))
    await app.bootstrap()

    const res = await app.request('/age-maxage-stale/data', { headers: { 'cache-control': 'max-age=10' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(callCount).toBe(1)
  })
})
