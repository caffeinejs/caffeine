import type { Logger } from '@caffeinejs/application/logger'
import { Controller, Get, Post, Status } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import {
  CacheControl,
  CacheInvalidate,
  HTTPCaching,
  type CacheBypassEvent,
  type CacheHitEvent,
  type CacheInvalidateEvent,
  type CacheMissEvent,
  type CacheObserver,
  type CacheStoreEvent,
  type HTTPCacheEntry,
  type HTTPCacheStore,
} from '../index.js'
import { RecordingLogger } from './_log.js'

class RecordingObserver implements CacheObserver {
  readonly hits: CacheHitEvent[] = []
  readonly misses: CacheMissEvent[] = []
  readonly bypasses: CacheBypassEvent[] = []
  readonly stores: CacheStoreEvent[] = []
  readonly invalidations: CacheInvalidateEvent[] = []

  onHit(event: CacheHitEvent): void {
    this.hits.push(event)
  }

  onMiss(event: CacheMissEvent): void {
    this.misses.push(event)
  }

  onBypass(event: CacheBypassEvent): void {
    this.bypasses.push(event)
  }

  onStore(event: CacheStoreEvent): void {
    this.stores.push(event)
  }

  onInvalidate(event: CacheInvalidateEvent): void {
    this.invalidations.push(event)
  }
}

let close: (() => Promise<unknown>) | undefined

afterEach(async () => {
  vi.useRealTimers()
  await close?.()
  close = undefined
})

async function start(observer: CacheObserver, options: { store?: HTTPCacheStore; logger?: Logger } = {}) {
  const store = options.store ?? new MemoryHTTPCacheStore()
  const app = createWebApplication({ logger: options.logger }).with(HTTPCaching(b => b.store(store).observer(observer)))
  close = () => app.close()
  await app.bootstrap()
  return app
}

describe('bypass events', () => {
  // The status header stays absent on this path; the observer does not. Without the event, every hit ratio
  // computed off the events would silently leave out the route's non-cacheable traffic.
  it('reports a method the route does not cache, though no status header says so', async () => {
    @Controller('/obs-method')
    class MethodController {
      @CacheControl({ ttl: 60 * Second })
      @Post('/data')
      data() {
        return { ok: true }
      }
    }
    void [MethodController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const res = await app.request('/obs-method/data', { method: 'POST' })

    expect(res.headers.get('x-cache')).toBeNull()
    expect(observer.bypasses.map(e => e.reason)).toEqual(['method'])
  })

  it('tells an Authorization bypass from a route declared private', async () => {
    @Controller('/obs-private')
    class PrivateController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/implicit')
      implicit() {
        return { ok: true }
      }

      @CacheControl({ ttl: 60 * Second, privacy: 'private' })
      @Get('/declared')
      declared() {
        return { ok: true }
      }
    }
    void [PrivateController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-private/implicit', { headers: { authorization: 'Bearer t' } })
    await app.request('/obs-private/declared')

    expect(observer.bypasses.map(e => e.reason)).toEqual(['authorization', 'private'])
  })

  it('reports Vary: * as vary-any', async () => {
    @Controller('/obs-vary-any')
    class VaryAnyController {
      @CacheControl({ ttl: 60 * Second, vary: ['*'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VaryAnyController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-vary-any/data')

    expect(observer.bypasses.map(e => e.reason)).toEqual(['vary-any'])
  })

  it('names the client directive that bypassed, in the order the cache tests them', async () => {
    @Controller('/obs-directive')
    class DirectiveController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [DirectiveController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-directive/data', { headers: { 'cache-control': 'no-cache' } })
    await app.request('/obs-directive/data', { headers: { 'cache-control': 'no-store' } })
    await app.request('/obs-directive/data', { headers: { 'cache-control': 'max-age=0' } })
    await app.request('/obs-directive/data', { headers: { pragma: 'no-cache' } })
    await app.request('/obs-directive/data', { headers: { 'cache-control': 'no-cache, max-age=0' } })

    expect(observer.bypasses.map(e => e.reason)).toEqual([
      'no-cache',
      'no-store',
      'max-age-0',
      'pragma-no-cache',
      'no-cache',
    ])
  })

  it('reports @CacheControl(false) as disabled, and stores nothing', async () => {
    @Controller('/obs-disabled')
    class DisabledController {
      @CacheControl(false)
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [DisabledController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-disabled/data')

    expect(observer.bypasses.map(e => e.reason)).toEqual(['disabled'])
    expect(observer.stores).toEqual([])
  })
})

describe('miss events', () => {
  it('reports a cold cache as absent, with the store key', async () => {
    @Controller('/obs-cold')
    class ColdController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ColdController]

    const observer = new RecordingObserver()
    const store = new MemoryHTTPCacheStore()
    const app = await start(observer, { store })

    await app.request('/obs-cold/data')

    expect(observer.misses).toEqual([
      {
        route: { method: 'GET', url: '/obs-cold/data', handler: 'ColdController.data' },
        key: expect.any(String),
        reason: 'absent',
      },
    ])
    // The key names the entry the response was then stored under.
    expect((await store.get(observer.misses[0].key))?.payload).toBe('{"ok":true}')
  })

  // The store was consulted, so it is a miss — but the request is answered 504 and nothing gets stored, which
  // is why it does not share `absent`'s reason.
  it('reports only-if-cached on a cold cache, which no status header reports', async () => {
    @Controller('/obs-only-if-cached')
    class OnlyIfCachedController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [OnlyIfCachedController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const res = await app.request('/obs-only-if-cached/data', { headers: { 'cache-control': 'only-if-cached' } })

    expect(res.status).toBe(504)
    expect(observer.misses.map(e => e.reason)).toEqual(['only-if-cached'])
    expect(observer.stores).toEqual([])
  })

  // An entry exists, so a store-level view would call this a hit; the handler still runs, so it is a miss.
  it('reports an entry older than the request allows as stale-for-request', async () => {
    class AgedStore implements HTTPCacheStore {
      async get(): Promise<HTTPCacheEntry> {
        return {
          payload: '{"ok":true}',
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          storedAt: Date.now() - 5000,
        }
      }
      async put(): Promise<void> {}
      async evictByTag(): Promise<void> {}
    }

    @Controller('/obs-stale')
    class StaleController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [StaleController]

    const observer = new RecordingObserver()
    const app = await start(observer, { store: new AgedStore() })

    const res = await app.request('/obs-stale/data', { headers: { 'cache-control': 'max-age=1' } })

    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(observer.misses.map(e => e.reason)).toEqual(['stale-for-request'])
    expect(observer.hits).toEqual([])
  })
})

describe('hit events', () => {
  it('reports a served body as a hit that was not revalidated', async () => {
    @Controller('/obs-hit')
    class HitController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [HitController]

    const observer = new RecordingObserver()
    const app = await start(observer)
    vi.useFakeTimers({ toFake: ['Date'] })

    await app.request('/obs-hit/data')
    vi.setSystemTime(Date.now() + 2000)
    await app.request('/obs-hit/data')

    expect(observer.hits).toHaveLength(1)
    expect(observer.hits[0]).toMatchObject({ key: observer.misses[0].key, revalidated: false, age: 2 * Second })
  })

  it('reports a 304 answered from If-None-Match or If-Modified-Since as revalidated', async () => {
    @Controller('/obs-revalidate')
    class RevalidateController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/etag')
      etag() {
        return { ok: true }
      }

      @CacheControl({ ttl: 60 * Second, etag: false })
      @Get('/modified')
      modified() {
        return { ok: true }
      }
    }
    void [RevalidateController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const etag = (await app.request('/obs-revalidate/etag')).headers.get('etag')!
    const byETag = await app.request('/obs-revalidate/etag', { headers: { 'if-none-match': etag } })

    const lastModified = (await app.request('/obs-revalidate/modified')).headers.get('last-modified')!
    const byDate = await app.request('/obs-revalidate/modified', { headers: { 'if-modified-since': lastModified } })

    expect(byETag.status).toBe(304)
    expect(byDate.status).toBe(304)
    expect(observer.hits.map(e => e.revalidated)).toEqual([true, true])
  })
})

describe('store events', () => {
  it("reports the stored bytes and the route's ttl", async () => {
    @Controller('/obs-store')
    class StoreController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/minute')
      minute() {
        return { ok: true }
      }

      @CacheControl({ ttl: 1500 * Millisecond })
      @Get('/brief')
      brief() {
        return { ok: true }
      }
    }
    void [StoreController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const body = await (await app.request('/obs-store/minute')).text()
    await app.request('/obs-store/brief')

    expect(observer.stores.map(e => [e.size, e.ttl])).toEqual([
      [Buffer.byteLength(body), 60 * Second],
      [Buffer.byteLength(body), 1_500 * Millisecond],
    ])
  })

  it('reports nothing stored when the status is not cacheable', async () => {
    @Controller('/obs-uncacheable')
    class UncacheableController {
      @CacheControl({ ttl: 60 * Second })
      @Status(500)
      @Get('/data')
      data() {
        return { ok: false }
      }
    }
    void [UncacheableController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-uncacheable/data')

    expect(observer.misses).toHaveLength(1)
    expect(observer.stores).toEqual([])
  })

  it('reports nothing stored when the store rejects the write', async () => {
    class FailingStore implements HTTPCacheStore {
      async get(): Promise<undefined> {
        return undefined
      }
      async put(): Promise<void> {
        throw new Error('store unavailable')
      }
      async evictByTag(): Promise<void> {}
    }

    @Controller('/obs-store-fails')
    class StoreFailsController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [StoreFailsController]

    const observer = new RecordingObserver()
    const app = await start(observer, { store: new FailingStore() })

    const res = await app.request('/obs-store-fails/data')

    // The write failed, the response did not: the handler's answer still goes out.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(observer.stores).toEqual([])
  })
})

describe('invalidate events', () => {
  it('reports the tags a successful mutation evicted, and nothing for a failed one', async () => {
    @Controller('/obs-invalidate')
    class InvalidateController {
      @CacheInvalidate({ tags: ['pets', 'all'] })
      @Post('/ok')
      ok() {
        return { ok: true }
      }

      @CacheInvalidate({ tags: ['pets'] })
      @Status(400)
      @Post('/rejected')
      rejected() {
        return { ok: false }
      }
    }
    void [InvalidateController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-invalidate/ok', { method: 'POST' })
    await app.request('/obs-invalidate/rejected', { method: 'POST' })

    expect(observer.invalidations).toEqual([
      {
        route: { method: 'POST', url: '/obs-invalidate/ok', handler: 'InvalidateController.ok' },
        tags: ['pets', 'all'],
      },
    ])
  })
})

describe('route identity', () => {
  it('carries the tags on the store event of a tagged route', async () => {
    @Controller('/obs-tags')
    class TagsController {
      @CacheControl({ ttl: 60 * Second, tags: ['pets'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [TagsController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-tags/data')
    await app.request('/obs-tags/data')

    expect(observer.stores.map(e => e.tags)).toEqual([['pets']])
    expect(observer.hits).toHaveLength(1)
  })

  // Built once when the route registers. An adapter may key its own per-route state on this object; rebuilding
  // it per request would break that and allocate on every request.
  it('hands every event from one route the same frozen object', async () => {
    @Controller('/obs-identity')
    class IdentityController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [IdentityController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-identity/data')
    await app.request('/obs-identity/data')
    await app.request('/obs-identity/data')
    await app.request('/obs-identity/data')

    const [first, second, third] = observer.hits.map(e => e.route)

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(observer.misses[0].route).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })

  // Fastify registers the HEAD twin of a GET route separately, so it reports its own method — while serving the
  // entry the GET stored.
  it('reports a HEAD request under the HEAD twin of the route', async () => {
    @Controller('/obs-head')
    class HeadController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [HeadController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.request('/obs-head/data')
    await app.request('/obs-head/data', { method: 'HEAD' })

    expect(observer.misses[0].route).toMatchObject({ method: 'GET', url: '/obs-head/data' })
    expect(observer.hits[0].route).toMatchObject({ method: 'HEAD', url: '/obs-head/data' })
  })
})

describe('a throwing observer', () => {
  // A metrics bug must not become an outage: the throw is caught where the cache calls the observer, on the
  // request and store paths alike, and the response is what it would have been.
  it('never reaches the response', async () => {
    @Controller('/obs-throws')
    class ThrowsController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ThrowsController]

    const boom = () => {
      throw new Error('boom')
    }
    const app = await start(
      { onHit: boom, onMiss: boom, onBypass: boom, onStore: boom },
      { logger: new RecordingLogger() },
    )

    const miss = await app.request('/obs-throws/data')
    const hit = await app.request('/obs-throws/data')
    const bypass = await app.request('/obs-throws/data', { headers: { 'cache-control': 'no-cache' } })

    expect([miss.status, miss.headers.get('x-cache')]).toEqual([200, 'MISS'])
    expect([hit.status, hit.headers.get('x-cache')]).toEqual([200, 'HIT'])
    expect([bypass.status, bypass.headers.get('x-cache')]).toEqual([200, 'BYPASS'])
    expect(await hit.json()).toEqual({ ok: true })
  })

  // On the application logger the cache was set up with, not on `request.log`: that one is silent under a
  // caller-supplied `fastify()`, and a report through it would carry the request it happened on.
  it('is reported once per method on the application logger', async () => {
    @Controller('/obs-throws-logged')
    class ThrowsLoggedController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ThrowsLoggedController]

    const logger = new RecordingLogger()
    const app = await start(
      {
        onHit: () => {
          throw new Error('boom')
        },
      },
      { logger },
    )

    await app.request('/obs-throws-logged/data')
    await app.request('/obs-throws-logged/data')
    await app.request('/obs-throws-logged/data')

    const reports = logger.written.filter(w => w.severity === 'error')

    expect(reports).toHaveLength(1)
    expect(reports[0].args[1]).toBe('Cache observer "onHit" threw; further throws from "onHit" are suppressed')
    expect(reports[0].bindings).not.toHaveProperty('reqId')
  })
})
