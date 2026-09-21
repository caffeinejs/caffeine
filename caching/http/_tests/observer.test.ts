import { Controller, Get, Post, Status, createWebApplication } from '@caffeinejs/http'
import type { Bindings, LevelMapping, LogFn, Logger } from '@caffeinejs/std/logger'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import type { Cache, CacheEntry } from '../../store.js'
import { MemoryCache } from '../../store/memory/index.js'
import { CacheControl, CacheInvalidate, HTTPCaching } from '../index.js'
import type {
  CacheBypassEvent,
  CacheHitEvent,
  CacheInvalidateEvent,
  CacheMissEvent,
  CacheObserver,
  CacheStoreEvent,
} from '../observer.js'

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

/** A `Logger` that keeps what it was asked to write. */
class Recorder implements Logger {
  level = 'trace'
  readonly levels: LevelMapping = {
    values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
    labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
  }

  readonly written: { severity: string; args: unknown[] }[] = []

  readonly trace = this.#record('trace')
  readonly debug = this.#record('debug')
  readonly info = this.#record('info')
  readonly warn = this.#record('warn')
  readonly error = this.#record('error')
  readonly fatal = this.#record('fatal')
  readonly silent = this.#record('silent')

  isLevelEnabled(): boolean {
    return true
  }

  bindings(): Bindings {
    return {}
  }

  child(): Logger {
    return this
  }

  flush(): void {
    // Nothing is buffered.
  }

  #record(severity: string): LogFn {
    return (...args: unknown[]): void => {
      this.written.push({ severity, args })
    }
  }
}

let close: (() => Promise<unknown>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

async function start(observer: CacheObserver, options: { store?: Cache; logger?: Logger } = {}) {
  const store = options.store ?? new MemoryCache()
  const app = createWebApplication({ logger: options.logger }).with(HTTPCaching(b => b.store(store).observer(observer)))
  close = () => app.close()
  await app.ready()
  return app
}

describe('bypass events', () => {
  // The status header stays absent on this path; the observer does not. Without the event, every hit ratio
  // computed off the events would silently leave out the route's non-cacheable traffic.
  it('reports a method the route does not cache, though no status header says so', async () => {
    @Controller('/obs-method')
    class MethodController {
      @CacheControl({ ttl: 60 })
      @Post('/data')
      data() {
        return { ok: true }
      }
    }
    void [MethodController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const res = await app.fetch('/obs-method/data', { method: 'POST' })

    expect(res.headers.get('x-cache')).toBeNull()
    expect(observer.bypasses.map(e => e.reason)).toEqual(['method'])
  })

  it('tells an Authorization bypass from a route declared private', async () => {
    @Controller('/obs-private')
    class PrivateController {
      @CacheControl({ ttl: 60 })
      @Get('/implicit')
      implicit() {
        return { ok: true }
      }

      @CacheControl({ ttl: 60, privacy: 'private' })
      @Get('/declared')
      declared() {
        return { ok: true }
      }
    }
    void [PrivateController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-private/implicit', { headers: { authorization: 'Bearer t' } })
    await app.fetch('/obs-private/declared')

    expect(observer.bypasses.map(e => e.reason)).toEqual(['authorization', 'private'])
  })

  it('reports Vary: * as vary-any', async () => {
    @Controller('/obs-vary-any')
    class VaryAnyController {
      @CacheControl({ ttl: 60, vary: ['*'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [VaryAnyController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-vary-any/data')

    expect(observer.bypasses.map(e => e.reason)).toEqual(['vary-any'])
  })

  it('names the client directive that bypassed, in the order the cache tests them', async () => {
    @Controller('/obs-directive')
    class DirectiveController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [DirectiveController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-directive/data', { headers: { 'cache-control': 'no-cache' } })
    await app.fetch('/obs-directive/data', { headers: { 'cache-control': 'no-store' } })
    await app.fetch('/obs-directive/data', { headers: { 'cache-control': 'max-age=0' } })
    await app.fetch('/obs-directive/data', { headers: { pragma: 'no-cache' } })
    await app.fetch('/obs-directive/data', { headers: { 'cache-control': 'no-cache, max-age=0' } })

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

    await app.fetch('/obs-disabled/data')

    expect(observer.bypasses.map(e => e.reason)).toEqual(['disabled'])
    expect(observer.stores).toEqual([])
  })
})

describe('miss events', () => {
  it('reports a cold cache as absent, with the store key', async () => {
    @Controller('/obs-cold')
    class ColdController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ColdController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-cold/data')

    expect(observer.misses).toEqual([
      {
        route: { method: 'GET', url: '/obs-cold/data', handler: 'ColdController.data' },
        segment: undefined,
        key: encodeURIComponent('/obs-cold/data'),
        reason: 'absent',
      },
    ])
  })

  // The store was consulted, so it is a miss — but the request is answered 504 and nothing gets stored, which
  // is why it does not share `absent`'s reason.
  it('reports only-if-cached on a cold cache, which no status header reports', async () => {
    @Controller('/obs-only-if-cached')
    class OnlyIfCachedController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [OnlyIfCachedController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const res = await app.fetch('/obs-only-if-cached/data', { headers: { 'cache-control': 'only-if-cached' } })

    expect(res.status).toBe(504)
    expect(observer.misses.map(e => e.reason)).toEqual(['only-if-cached'])
    expect(observer.stores).toEqual([])
  })

  // An entry exists, so a store-level view would call this a hit; the handler still runs, so it is a miss.
  it('reports an entry older than the request allows as stale-for-request', async () => {
    class AgedStore implements Cache {
      async get(): Promise<CacheEntry> {
        return {
          payload: '{"ok":true}',
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          storedAt: Date.now() - 5000,
        }
      }
      async getMany(keys: string[]): Promise<CacheEntry[]> {
        return Promise.all(keys.map(() => this.get()))
      }
      async put(): Promise<void> {}
      async putMany(): Promise<void> {}
      async delete(): Promise<void> {}
      async deleteMany(): Promise<void> {}
      async clear(): Promise<void> {}
    }

    @Controller('/obs-stale')
    class StaleController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [StaleController]

    const observer = new RecordingObserver()
    const app = await start(observer, { store: new AgedStore() })

    const res = await app.fetch('/obs-stale/data', { headers: { 'cache-control': 'max-age=1' } })

    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(observer.misses.map(e => e.reason)).toEqual(['stale-for-request'])
    expect(observer.hits).toEqual([])
  })
})

describe('hit events', () => {
  it('reports a served body as a hit that was not revalidated', async () => {
    @Controller('/obs-hit')
    class HitController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [HitController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-hit/data')
    await app.fetch('/obs-hit/data')

    expect(observer.hits).toHaveLength(1)
    expect(observer.hits[0]).toMatchObject({ key: encodeURIComponent('/obs-hit/data'), revalidated: false })
    expect(observer.hits[0].ageSeconds).toBeGreaterThanOrEqual(0)
  })

  it('reports a 304 answered from If-None-Match or If-Modified-Since as revalidated', async () => {
    @Controller('/obs-revalidate')
    class RevalidateController {
      @CacheControl({ ttl: 60 })
      @Get('/etag')
      etag() {
        return { ok: true }
      }

      @CacheControl({ ttl: 60, etag: false })
      @Get('/modified')
      modified() {
        return { ok: true }
      }
    }
    void [RevalidateController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const etag = (await app.fetch('/obs-revalidate/etag')).headers.get('etag')!
    const byETag = await app.fetch('/obs-revalidate/etag', { headers: { 'if-none-match': etag } })

    const lastModified = (await app.fetch('/obs-revalidate/modified')).headers.get('last-modified')!
    const byDate = await app.fetch('/obs-revalidate/modified', { headers: { 'if-modified-since': lastModified } })

    expect(byETag.status).toBe(304)
    expect(byDate.status).toBe(304)
    expect(observer.hits.map(e => e.revalidated)).toEqual([true, true])
  })
})

describe('store events', () => {
  it('reports the stored bytes and the ttl in seconds, fractional below one', async () => {
    @Controller('/obs-store')
    class StoreController {
      @CacheControl({ ttl: 60 })
      @Get('/minute')
      minute() {
        return { ok: true }
      }

      @CacheControl({ ttl: '500ms' })
      @Get('/brief')
      brief() {
        return { ok: true }
      }
    }
    void [StoreController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    const body = await (await app.fetch('/obs-store/minute')).text()
    await app.fetch('/obs-store/brief')

    expect(observer.stores.map(e => [e.bytes, e.ttlSeconds])).toEqual([
      [Buffer.byteLength(body), 60],
      [Buffer.byteLength(body), 0.5],
    ])
  })

  it('reports nothing stored when the status is not cacheable', async () => {
    @Controller('/obs-uncacheable')
    class UncacheableController {
      @CacheControl({ ttl: 60 })
      @Status(500)
      @Get('/data')
      data() {
        return { ok: false }
      }
    }
    void [UncacheableController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-uncacheable/data')

    expect(observer.misses).toHaveLength(1)
    expect(observer.stores).toEqual([])
  })

  it('reports nothing stored when the store rejects the write', async () => {
    class FailingStore implements Cache {
      async get(): Promise<undefined> {
        return undefined
      }
      async getMany(keys: string[]): Promise<undefined[]> {
        return keys.map(() => undefined)
      }
      async put(): Promise<void> {
        throw new Error('store unavailable')
      }
      async putMany(): Promise<void> {
        throw new Error('store unavailable')
      }
      async delete(): Promise<void> {}
      async deleteMany(): Promise<void> {}
      async clear(): Promise<void> {}
    }

    @Controller('/obs-store-fails')
    class StoreFailsController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [StoreFailsController]

    const observer = new RecordingObserver()
    const app = await start(observer, { store: new FailingStore() })

    const res = await app.fetch('/obs-store-fails/data')

    // The write failed, the response did not: the handler's answer still goes out.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(observer.stores).toEqual([])
  })
})

describe('invalidate events', () => {
  it('reports the keys a successful mutation evicted, and nothing for a failed one', async () => {
    @Controller('/obs-invalidate')
    class InvalidateController {
      @CacheInvalidate({ paths: ['/obs-invalidate/a', '/obs-invalidate/b?y=2&x=1'] })
      @Post('/ok')
      ok() {
        return { ok: true }
      }

      @CacheInvalidate()
      @Status(400)
      @Post('/rejected')
      rejected() {
        return { ok: false }
      }
    }
    void [InvalidateController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-invalidate/ok', { method: 'POST' })
    await app.fetch('/obs-invalidate/rejected', { method: 'POST' })

    expect(observer.invalidations).toEqual([
      {
        route: { method: 'POST', url: '/obs-invalidate/ok', handler: 'InvalidateController.ok' },
        segment: undefined,
        scope: 'keys',
        keys: [encodeURIComponent('/obs-invalidate/a'), encodeURIComponent('/obs-invalidate/b?x=1&y=2')],
      },
    ])
  })

  it('reports a segment clear by its segment', async () => {
    @Controller('/obs-clear')
    class ClearController {
      @CacheInvalidate({ segment: 'products', clear: true })
      @Post('/products')
      update() {
        return { ok: true }
      }
    }
    void [ClearController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-clear/products', { method: 'POST' })

    expect(observer.invalidations).toMatchObject([{ scope: 'segment', segment: 'products' }])
  })
})

describe('route identity', () => {
  it('carries the segment on every event from a segmented route', async () => {
    @Controller('/obs-segment')
    class SegmentController {
      @CacheControl({ ttl: 60, segment: 'pets' })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [SegmentController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-segment/data')
    await app.fetch('/obs-segment/data')
    // Bypasses the read, then stores the fresh response it got.
    await app.fetch('/obs-segment/data', { headers: { 'cache-control': 'no-cache' } })

    const events = [...observer.misses, ...observer.stores, ...observer.hits, ...observer.bypasses]

    expect(events.map(e => e.segment)).toEqual(['pets', 'pets', 'pets', 'pets', 'pets'])
    expect([observer.misses, observer.stores, observer.hits, observer.bypasses].map(list => list.length)).toEqual([
      1, 2, 1, 1,
    ])
  })

  // Built once when the route registers. An adapter may key its own per-route state on this object; rebuilding
  // it per request would break that and allocate on every request.
  it('hands every event from one route the same frozen object', async () => {
    @Controller('/obs-identity')
    class IdentityController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [IdentityController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-identity/data')
    await app.fetch('/obs-identity/data')
    await app.fetch('/obs-identity/data')
    await app.fetch('/obs-identity/data')

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
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [HeadController]

    const observer = new RecordingObserver()
    const app = await start(observer)

    await app.fetch('/obs-head/data')
    await app.fetch('/obs-head/data', { method: 'HEAD' })

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
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ThrowsController]

    const boom = () => {
      throw new Error('boom')
    }
    const app = await start({ onHit: boom, onMiss: boom, onBypass: boom, onStore: boom }, { logger: new Recorder() })

    const miss = await app.fetch('/obs-throws/data')
    const hit = await app.fetch('/obs-throws/data')
    const bypass = await app.fetch('/obs-throws/data', { headers: { 'cache-control': 'no-cache' } })

    expect([miss.status, miss.headers.get('x-cache')]).toEqual([200, 'MISS'])
    expect([hit.status, hit.headers.get('x-cache')]).toEqual([200, 'HIT'])
    expect([bypass.status, bypass.headers.get('x-cache')]).toEqual([200, 'BYPASS'])
    expect(await hit.json()).toEqual({ ok: true })
  })

  // The server here is a bare `fastify()`, whose own logger discards everything. The throw is still reported,
  // because it goes to the application logger.
  it('is reported once per method on the application logger', async () => {
    @Controller('/obs-throws-logged')
    class ThrowsLoggedController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ThrowsLoggedController]

    const logger = new Recorder()
    const app = await start(
      {
        onHit: () => {
          throw new Error('boom')
        },
      },
      { logger },
    )

    await app.fetch('/obs-throws-logged/data')
    await app.fetch('/obs-throws-logged/data')
    await app.fetch('/obs-throws-logged/data')

    const reports = logger.written.filter(w => w.severity === 'error')

    expect(reports).toHaveLength(1)
    expect(reports[0].args[1]).toBe('Cache observer "onHit" threw; further throws from "onHit" are suppressed')
  })
})
