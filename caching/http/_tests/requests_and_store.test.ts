import { Readable } from 'node:stream'

import { Controller, Get, Header, Post, Status } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { LRUCache } from 'lru-cache'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore, type MemoryHTTPCacheRecord } from '../../store/memory/index.js'
import {
  CacheControl,
  CacheInvalidate,
  ErrCacheStoreTimeout,
  HTTPCaching,
  type CacheErrorEvent,
  type CacheMissEvent,
  type CacheObserver,
  type CacheSkipEvent,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCachePutOptions,
  type HTTPCacheStore,
} from '../index.js'
import { RecordingLogger } from './_log.js'

describe('what a request may ask of the cache', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  // RFC 9111 §5.2.1.5: nothing of a no-store exchange is kept. The cache used to skip the read and store anyway.
  it('stores nothing of a request that said no-store', async () => {
    let calls = 0

    @Controller('/req-no-store')
    class NoStoreRequestController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [NoStoreRequestController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/req-no-store/data', { headers: { 'cache-control': 'No-Store' } })
    const next = await app.fetch('/req-no-store/data')

    expect(next.headers.get('x-cache')).toBe('MISS')
    expect(await next.json()).toEqual({ n: 2 })
  })

  it('reads a directive whatever its case', async () => {
    let calls = 0

    @Controller('/req-case')
    class CaseController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [CaseController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/req-case/data')
    const fresh = await app.fetch('/req-case/data', { headers: { 'cache-control': 'No-Cache' } })

    expect(fresh.headers.get('x-cache')).toBe('BYPASS')
    expect(await fresh.json()).toEqual({ n: 2 })
  })

  // RFC 9111 §5.4: Pragma speaks only for a request that sent no Cache-Control.
  it('ignores Pragma next to a Cache-Control header', async () => {
    @Controller('/req-pragma')
    class PragmaController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [PragmaController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/req-pragma/data')
    const res = await app.fetch('/req-pragma/data', { headers: { pragma: 'no-cache', 'cache-control': 'max-age=60' } })

    expect(res.headers.get('x-cache')).toBe('HIT')
  })

  // only-if-cached means "do not run the handler for me". An entry too old for the request is no entry.
  it('answers 504 to only-if-cached when the stored entry is older than the request accepts', async () => {
    let calls = 0

    @Controller('/req-only-if-cached')
    class OnlyIfCachedController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [OnlyIfCachedController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    // Only the clock the cache reads an entry's age from is moved; the store's own ttl runs on another.
    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/req-only-if-cached/data')
    vi.setSystemTime(Date.now() + 2100)
    const res = await app.fetch('/req-only-if-cached/data', {
      headers: { 'cache-control': 'only-if-cached, max-age=1' },
    })

    expect(res.status).toBe(504)
    expect(calls).toBe(1)
  })
})

/**
 * The query is part of the key, but not all of it has to be: a tracking parameter must not give every visitor
 * an entry of their own.
 */
describe('what of the query the key carries', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  const calls = { listed: 0, unlisted: 0, none: 0 }

  @Controller('/query')
  class QueryController {
    @CacheControl({ ttl: 60 * Second, varyByQuery: ['page'] })
    @Get('/listed')
    listed() {
      return { n: ++calls.listed }
    }

    @CacheControl({ ttl: 60 * Second })
    @Get('/unlisted')
    unlisted() {
      return { n: ++calls.unlisted }
    }

    @CacheControl({ ttl: 60 * Second, varyByQuery: [] })
    @Get('/none')
    none() {
      return { n: ++calls.none }
    }
  }
  void [QueryController]

  const status = async (app: { fetch(url: string): Promise<Response> }, url: string) =>
    (await app.fetch(url)).headers.get('x-cache')

  it('keeps the parameters a route lists and drops the rest, in any order', async () => {
    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    expect(await status(app, '/query/listed?page=1&utm_source=mail')).toBe('MISS')
    expect(await status(app, '/query/listed?utm_source=ad&page=1')).toBe('HIT')
    expect(await status(app, '/query/listed?page=2')).toBe('MISS')
    expect(await status(app, '/query/listed?page=2&utm_campaign=x')).toBe('HIT')
  })

  it('falls back to the install list, and a route may leave the whole query out', async () => {
    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).varyByQuery(['q'])))
    close = () => app.close()
    await app.bootstrap()

    expect(await status(app, '/query/unlisted?q=cat&utm_source=mail')).toBe('MISS')
    expect(await status(app, '/query/unlisted?q=cat')).toBe('HIT')
    expect(await status(app, '/query/unlisted?q=dog')).toBe('MISS')

    expect(await status(app, '/query/none?anything=1')).toBe('MISS')
    expect(await status(app, '/query/none?other=2')).toBe('HIT')
    expect(await status(app, '/query/none')).toBe('HIT')
  })

  it('counts the whole query when nobody lists anything', async () => {
    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    expect(await status(app, '/query/unlisted?a=1')).toBe('MISS')
    expect(await status(app, '/query/unlisted?a=2')).toBe('MISS')
    expect(await status(app, '/query/unlisted?a=1')).toBe('HIT')
  })
})

/** A response the policy would store, left out: the observer is told, with what it would have cost. */
describe('a response left out of the store', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  @Controller('/skip')
  class SkipController {
    @CacheControl({ ttl: 60 * Second })
    @Get('/large')
    large() {
      return 'x'.repeat(200)
    }

    @CacheControl({ ttl: 60 * Second })
    @Get('/small')
    small() {
      return 'x'.repeat(20)
    }

    @CacheControl({ ttl: 60 * Second })
    @Header('Set-Cookie', 'session=1')
    @Get('/cookie')
    cookie() {
      return { ok: true }
    }

    @CacheControl({ ttl: 60 * Second })
    @Get('/stream')
    stream() {
      return Readable.from(['str', 'eam'])
    }

    @CacheControl({ ttl: 60 * Second })
    @Get('/empty')
    empty() {}
  }
  void [SkipController]

  it('is larger than maxEntrySize: it goes out, is not stored, and is reported', async () => {
    const skips: CacheSkipEvent[] = []
    const app = createWebApplication().with(
      HTTPCaching(b =>
        b
          .store(new MemoryHTTPCacheStore())
          .maxEntrySize(100)
          .observer({ onSkip: e => skips.push(e) }),
      ),
    )
    close = () => app.close()
    await app.bootstrap()

    const first = await app.fetch('/skip/large')
    const second = await app.fetch('/skip/large')
    await app.fetch('/skip/small')
    const small = await app.fetch('/skip/small')

    expect(first.status).toBe(200)
    expect(await first.text()).toBe('x'.repeat(200))
    expect(second.headers.get('x-cache')).toBe('MISS')
    expect(small.headers.get('x-cache')).toBe('HIT')
    expect(skips).toMatchObject([
      { route: { url: '/skip/large' }, reason: 'entry-too-large', bytes: 200 },
      { route: { url: '/skip/large' }, reason: 'entry-too-large', bytes: 200 },
    ])
  })

  it('sets a cookie: it is reported the same way', async () => {
    const skips: CacheSkipEvent[] = []
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer({ onSkip: e => skips.push(e) })),
    )
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/skip/cookie')

    expect(skips).toMatchObject([{ route: { url: '/skip/cookie' }, reason: 'set-cookie', bytes: 11 }])
  })

  // A compressor installed ahead of the cache hands it a stream on every response: without a report the cache
  // is silently empty.
  it('is a stream: it goes out, is not stored, and is reported without a size', async () => {
    const skips: CacheSkipEvent[] = []
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer({ onSkip: e => skips.push(e) })),
    )
    close = () => app.close()
    await app.bootstrap()

    const first = await app.fetch('/skip/stream')
    const second = await app.fetch('/skip/stream')

    expect(await first.text()).toBe('stream')
    expect(second.headers.get('x-cache')).toBe('MISS')
    expect(skips).toHaveLength(2)
    for (const skip of skips) {
      expect(skip).toEqual({
        route: expect.objectContaining({ url: '/skip/stream' }),
        key: expect.any(String),
        reason: 'stream',
      })
      expect(skip).not.toHaveProperty('bytes')
    }
  })

  // A handler that returned nothing: the server sends an empty body, and there is nothing to hash or replay.
  // Without a report the route is a miss forever, indistinguishable from a store that keeps rejecting.
  it('has no body: it goes out, is not stored, and is reported with a size of zero', async () => {
    const skips: CacheSkipEvent[] = []
    const stores: unknown[] = []
    const app = createWebApplication().with(
      HTTPCaching(b =>
        b.store(new MemoryHTTPCacheStore()).observer({ onSkip: e => skips.push(e), onStore: e => stores.push(e) }),
      ),
    )
    close = () => app.close()
    await app.bootstrap()

    const first = await app.fetch('/skip/empty')
    const second = await app.fetch('/skip/empty')

    expect(first.status).toBe(200)
    expect(await first.text()).toBe('')
    expect(first.headers.get('cache-control')).toBe('public, max-age=60')
    expect(second.headers.get('x-cache')).toBe('MISS')
    expect(stores).toEqual([])
    expect(skips).toMatchObject([
      { route: { url: '/skip/empty' }, reason: 'empty', bytes: 0 },
      { route: { url: '/skip/empty' }, reason: 'empty', bytes: 0 },
    ])
  })

  // A request that said `no-cache` is not answered from the store, so nothing derived its key on the way in. Its
  // response is still one the store would have kept, and is reported under the key it would have been kept by.
  it('is reported under its key when the request bypassed the read', async () => {
    const skips: CacheSkipEvent[] = []
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer({ onSkip: e => skips.push(e) })),
    )
    close = () => app.close()
    await app.bootstrap()

    for (const path of ['/skip/stream', '/skip/empty']) {
      await app.fetch(path)
      const bypassed = await app.fetch(path, { headers: { 'cache-control': 'no-cache' } })
      expect(bypassed.headers.get('x-cache')).toBe('BYPASS')
    }

    expect(skips.map(skip => skip.reason)).toEqual(['stream', 'stream', 'empty', 'empty'])
    expect(skips[1].key).toBe(skips[0].key)
    expect(skips[3].key).toBe(skips[2].key)
  })

  it('refuses a maxEntrySize that is not a byte size at start-up', async () => {
    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).maxEntrySize('lots')))
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(/maxEntrySize must be a byte size/)
  })
})

/**
 * A store that is down is a cache that is off, not an application that is down: every request used to answer
 * 500, the mutation that had already gone through included.
 */
describe('a store that rejects', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  class DownStore implements HTTPCacheStore {
    readonly inner = new MemoryHTTPCacheStore()
    failGet = false
    failPut = false
    failEvict = false

    async get(key: string, options?: HTTPCacheGetOptions) {
      if (this.failGet) {
        throw new Error('store down')
      }
      return this.inner.get(key, options)
    }
    async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions) {
      if (this.failPut) {
        throw new Error('store down')
      }
      return this.inner.put(key, entry, options)
    }
    async evictByTag() {
      if (this.failEvict) {
        throw new Error('store down')
      }
    }
  }

  @Controller('/store-down')
  class StoreDownController {
    @CacheControl({ ttl: 60 * Second, tags: ['pets'] })
    @Get('/data')
    data() {
      return { ok: true }
    }

    @CacheInvalidate({ tags: ['pets'] })
    @Status(201)
    @Post('/data')
    create() {
      return { created: true }
    }
  }
  void [StoreDownController]

  it('answers the request without the cache, and tells the observer which call failed', async () => {
    const store = new DownStore()
    const errors: CacheErrorEvent[] = []
    const stored: unknown[] = []
    const invalidated: unknown[] = []
    const observer: CacheObserver = {
      onError: event => errors.push(event),
      onStore: event => stored.push(event),
      onInvalidate: event => invalidated.push(event),
    }

    const app = createWebApplication().with(HTTPCaching(b => b.store(store).observer(observer)))
    close = () => app.close()
    await app.bootstrap()

    store.failPut = true
    const written = await app.fetch('/store-down/data')
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ ok: true })

    store.failGet = true
    const read = await app.fetch('/store-down/data')
    expect(read.status).toBe(200)
    expect(read.headers.get('x-cache')).toBe('MISS')
    expect(await read.json()).toEqual({ ok: true })

    store.failEvict = true
    const mutated = await app.fetch('/store-down/data', { method: 'POST' })
    expect(mutated.status).toBe(201)
    expect(await mutated.json()).toEqual({ created: true })

    expect(errors.map(event => event.operation)).toEqual(['put', 'get', 'put', 'evict'])
    expect((errors[0].error as Error).message).toBe('store down')
    // An event says what happened: a write and an eviction that rejected did not.
    expect(stored).toEqual([])
    expect(invalidated).toEqual([])
  })

  it('logs the failure on the application logger when no observer listens for it, once', async () => {
    const store = new DownStore()
    store.failGet = true
    const log = new RecordingLogger()

    const app = createWebApplication({ logger: log }).with(HTTPCaching(b => b.store(store).observer({ onHit() {} })))
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/store-down/data')
    await app.fetch('/store-down/data')

    const reports = log.written.filter(w => String(w.args[1]).includes('Cache store "get" failed'))
    expect(reports).toHaveLength(1)
    expect(reports[0].severity).toBe('error')
    expect(reports[0].bindings).not.toHaveProperty('reqId')
  })

  it('leaves the report to an observer that listens for failures', async () => {
    const store = new DownStore()
    store.failGet = true
    const log = new RecordingLogger()
    const errors: CacheErrorEvent[] = []

    const app = createWebApplication({ logger: log }).with(
      HTTPCaching(b => b.store(store).observer({ onError: event => errors.push(event) })),
    )
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/store-down/data')

    expect(errors).toHaveLength(1)
    expect(log.written.filter(w => String(w.args[1]).includes('Cache store'))).toEqual([])
  })
})

/**
 * A store that rejects costs the cache. One that never answers — a client queueing commands while its server is
 * gone — would cost every request on a cached route, unless the wait is bounded.
 */
describe('a store that never answers', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  const never = new Promise<never>(() => {})

  class HungStore implements HTTPCacheStore {
    get(): Promise<HTTPCacheEntry | undefined> {
      return never
    }
    put(): Promise<void> {
      return never
    }
    evictByTag(): Promise<void> {
      return never
    }
  }

  @Controller('/store-hung')
  class StoreHungController {
    @CacheControl({ ttl: 60 * Second, tags: ['pets'] })
    @Get('/data')
    data() {
      return { ok: true }
    }

    @CacheInvalidate({ tags: ['pets'] })
    @Post('/data')
    create() {
      return { created: true }
    }
  }
  void [StoreHungController]

  it('gives up on each store call after storeTimeout, and reports it like a failure', async () => {
    const errors: CacheErrorEvent[] = []
    const app = createWebApplication().with(
      HTTPCaching(b =>
        b
          .store(new HungStore())
          .storeTimeout(20 * Millisecond)
          .observer({ onError: event => errors.push(event) }),
      ),
    )
    close = () => app.close()
    await app.bootstrap()

    const read = await app.fetch('/store-hung/data')
    const evicted = await app.fetch('/store-hung/data', { method: 'POST' })

    expect(read.status).toBe(200)
    expect(read.headers.get('x-cache')).toBe('MISS')
    expect(await read.json()).toEqual({ ok: true })
    expect(evicted.status).toBe(200)

    expect(errors.map(event => event.operation)).toEqual(['get', 'put', 'evict'])
    for (const event of errors) {
      expect(event.error).toBeInstanceOf(ErrCacheStoreTimeout)
    }
    expect((errors[0].error as ErrCacheStoreTimeout).code).toBe('ERR_CACHE_STORE_TIMEOUT')
    expect((errors[0].error as Error).message).toBe('Cannot wait for the cache store: "get" did not settle within 20ms')
  })

  it.each([0, -1, 'soon', Number.NaN])('refuses a storeTimeout of %s', async value => {
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).storeTimeout(value as number)),
    )
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(/storeTimeout must be a positive duration/)
  })
})

/**
 * The hooks are not the only writer a store may have: an application can fill it ahead of traffic. Such an
 * entry carries no `storedAt`, and is served as one that was just stored.
 */
describe('an entry the application put in the store itself', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  it('is served as a hit, with an age of zero', async () => {
    let calls = 0
    const store = new MemoryHTTPCacheStore()

    @Controller('/store-warm')
    class WarmStoreController {
      @CacheControl({ ttl: 60 * Second, key: () => 'store-warm' })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [WarmStoreController]

    await store.put(
      'store-warm',
      { payload: '{"warm":true}', statusCode: 200, headers: { 'content-type': 'application/json' } },
      { ttl: 60 * Second },
    )

    const app = createWebApplication().with(HTTPCaching(b => b.store(store)))
    close = () => app.close()
    await app.bootstrap()
    const res = await app.fetch('/store-warm/data')

    expect(res.headers.get('x-cache')).toBe('HIT')
    expect(res.headers.get('age')).toBe('0')
    expect(await res.json()).toEqual({ warm: true })
    expect(calls).toBe(0)
  })
})

// `MemoryHTTPCacheStore` runs on a caller's `LRUCache` as given, `allowStale` included: what the store hands
// back is checked against the route's ttl rather than believed.
describe('a store that hands back an entry past the route ttl', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  it('is treated as a miss', async () => {
    let calls = 0
    const misses: CacheMissEvent[] = []
    const lru = new LRUCache<string, MemoryHTTPCacheRecord>({ max: 10, allowStale: true, noDeleteOnStaleGet: true })

    @Controller('/store-stale')
    class StaleStoreController {
      @CacheControl({ ttl: 1 * Second })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [StaleStoreController]

    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore(lru)).observer({ onMiss: event => misses.push(event) })),
    )
    close = () => app.close()
    await app.bootstrap()

    // `allowStale` hands the entry back whatever its age, so the clock the cache reads is the only one to move.
    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/store-stale/data')
    vi.setSystemTime(Date.now() + 2100)
    const res = await app.fetch('/store-stale/data')

    expect(await res.json()).toEqual({ n: 2 })
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(misses.map(event => event.reason)).toEqual(['absent', 'expired'])
  })
})
