import { setTimeout as sleep } from 'node:timers/promises'

import { Controller, Get, Post, Status, createWebApplication } from '@caffeinejs/http'
import type { Bindings, LevelMapping, LogFn, Logger } from '@caffeinejs/std/logger'
import { LRUCache } from 'lru-cache'
import { afterEach, describe, expect, it } from 'vitest'

import type { Cache, CacheEntry } from '../../store.js'
import { MemoryCache } from '../../store/memory/index.js'
import {
  CacheControl,
  CacheInvalidate,
  HTTPCaching,
  type CacheErrorEvent,
  type CacheMissEvent,
  type CacheObserver,
} from '../index.js'

describe('what a request may ask of the cache', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // RFC 9111 §5.2.1.5: nothing of a no-store exchange is kept. The cache used to skip the read and store anyway.
  it('stores nothing of a request that said no-store', async () => {
    let calls = 0

    @Controller('/req-no-store')
    class NoStoreRequestController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [NoStoreRequestController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    await app.fetch('/req-no-store/data', { headers: { 'cache-control': 'No-Store' } })
    const next = await app.fetch('/req-no-store/data')

    expect(next.headers.get('x-cache')).toBe('MISS')
    expect(await next.json()).toEqual({ n: 2 })
  })

  it('reads a directive whatever its case', async () => {
    let calls = 0

    @Controller('/req-case')
    class CaseController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [CaseController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    await app.fetch('/req-case/data')
    const fresh = await app.fetch('/req-case/data', { headers: { 'cache-control': 'No-Cache' } })

    expect(fresh.headers.get('x-cache')).toBe('BYPASS')
    expect(await fresh.json()).toEqual({ n: 2 })
  })

  // RFC 9111 §5.4: Pragma speaks only for a request that sent no Cache-Control.
  it('ignores Pragma next to a Cache-Control header', async () => {
    @Controller('/req-pragma')
    class PragmaController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [PragmaController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    await app.fetch('/req-pragma/data')
    const res = await app.fetch('/req-pragma/data', { headers: { pragma: 'no-cache', 'cache-control': 'max-age=60' } })

    expect(res.headers.get('x-cache')).toBe('HIT')
  })

  // only-if-cached means "do not run the handler for me". An entry too old for the request is no entry.
  it('answers 504 to only-if-cached when the stored entry is older than the request accepts', async () => {
    let calls = 0

    @Controller('/req-only-if-cached')
    class OnlyIfCachedController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [OnlyIfCachedController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    await app.fetch('/req-only-if-cached/data')
    await sleep(2100)
    const res = await app.fetch('/req-only-if-cached/data', {
      headers: { 'cache-control': 'only-if-cached, max-age=1' },
    })

    expect(res.status).toBe(504)
    expect(calls).toBe(1)
  })
})

/** A `Logger` that keeps what it was asked to write at `error`. */
class ErrorRecorder implements Logger {
  level = 'trace'
  readonly levels: LevelMapping = {
    values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
    labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
  }
  readonly errors: unknown[][] = []

  readonly trace = this.#ignore()
  readonly debug = this.#ignore()
  readonly info = this.#ignore()
  readonly warn = this.#ignore()
  readonly fatal = this.#ignore()
  readonly silent = this.#ignore()
  readonly error: LogFn = (...args: unknown[]): void => {
    this.errors.push(args)
  }

  isLevelEnabled(): boolean {
    return true
  }

  bindings(): Bindings {
    return {}
  }

  child(): Logger {
    return this
  }

  flush(): void {}

  #ignore(): LogFn {
    return (): void => {}
  }
}

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

  class DownStore implements Cache {
    readonly inner = new MemoryCache()
    failGet = false
    failPut = false
    failEvict = false

    async get(key: string, segment?: string) {
      if (this.failGet) {
        throw new Error('store down')
      }
      return this.inner.get(key, segment)
    }
    async getMany(keys: string[], segment?: string) {
      return Promise.all(keys.map(key => this.get(key, segment)))
    }
    async put(key: string, entry: CacheEntry, ttl: number, segment?: string) {
      if (this.failPut) {
        throw new Error('store down')
      }
      return this.inner.put(key, entry, ttl, segment)
    }
    async putMany() {
      throw new Error('not used')
    }
    async delete() {}
    async deleteMany() {
      if (this.failEvict) {
        throw new Error('store down')
      }
    }
    async clear() {
      if (this.failEvict) {
        throw new Error('store down')
      }
    }
  }

  @Controller('/store-down')
  class StoreDownController {
    @CacheControl({ ttl: 60 })
    @Get('/data')
    data() {
      return { ok: true }
    }

    @CacheInvalidate()
    @Status(201)
    @Post('/data')
    create() {
      return { created: true }
    }

    @CacheInvalidate({ clear: true, segment: 'pets' })
    @Post('/clear')
    clear() {
      return { cleared: true }
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
    await app.ready()

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
    expect((await app.fetch('/store-down/clear', { method: 'POST' })).status).toBe(200)

    expect(errors.map(event => event.operation)).toEqual(['put', 'get', 'put', 'delete', 'clear'])
    expect((errors[0].error as Error).message).toBe('store down')
    // An event says what happened: a write and an eviction that rejected did not.
    expect(stored).toEqual([])
    expect(invalidated).toEqual([])
  })

  it('logs the failure on the application logger when no observer listens for it, once', async () => {
    const store = new DownStore()
    store.failGet = true
    const log = new ErrorRecorder()

    const app = createWebApplication({ logger: log }).with(HTTPCaching(b => b.store(store).observer({ onHit() {} })))
    close = () => app.close()
    await app.ready()

    await app.fetch('/store-down/data')
    await app.fetch('/store-down/data')

    const reports = log.errors.filter(args => String(args[1]).includes('Cache store "get" failed'))
    expect(reports).toHaveLength(1)
  })

  it('leaves the report to an observer that listens for failures', async () => {
    const store = new DownStore()
    store.failGet = true
    const log = new ErrorRecorder()
    const errors: CacheErrorEvent[] = []

    const app = createWebApplication({ logger: log }).with(
      HTTPCaching(b => b.store(store).observer({ onError: event => errors.push(event) })),
    )
    close = () => app.close()
    await app.ready()

    await app.fetch('/store-down/data')

    expect(errors).toHaveLength(1)
    expect(log.errors.filter(args => String(args[1]).includes('Cache store'))).toEqual([])
  })
})

// `MemoryCache` runs on a caller's `LRUCache` as given, `allowStale` included: what the store hands back is
// checked against the route's ttl rather than believed.
/**
 * The hooks are not the only writer a store may have: `putMany` exists so an application can fill it ahead of
 * traffic. Such an entry carries no `storedAt`, and is served as one that was just stored.
 */
describe('an entry the application put in the store itself', () => {
  it('is served as a hit, with an age of zero', async () => {
    let calls = 0
    const store = new MemoryCache()

    @Controller('/store-warm')
    class WarmStoreController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [WarmStoreController]

    await store.putMany([
      {
        key: encodeURIComponent('/store-warm/data'),
        entry: { payload: '{"warm":true}', statusCode: 200, headers: { 'content-type': 'application/json' } },
        ttl: 60,
      },
    ])

    const app = createWebApplication().with(HTTPCaching(b => b.store(store)))
    await app.ready()
    const res = await app.fetch('/store-warm/data')
    await app.close()

    expect(res.headers.get('x-cache')).toBe('HIT')
    expect(res.headers.get('age')).toBe('0')
    expect(await res.json()).toEqual({ warm: true })
    expect(calls).toBe(0)
  })
})

describe('a store that hands back an entry past the route ttl', () => {
  it('is treated as a miss', async () => {
    let calls = 0
    const misses: CacheMissEvent[] = []
    const lru = new LRUCache<string, CacheEntry>({ max: 10, allowStale: true, noDeleteOnStaleGet: true })

    @Controller('/store-stale')
    class StaleStoreController {
      @CacheControl({ ttl: '1s' })
      @Get('/data')
      data() {
        return { n: ++calls }
      }
    }
    void [StaleStoreController]

    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryCache(lru)).observer({ onMiss: event => misses.push(event) })),
    )
    await app.ready()

    await app.fetch('/store-stale/data')
    await sleep(2100)
    const res = await app.fetch('/store-stale/data')
    await app.close()

    expect(await res.json()).toEqual({ n: 2 })
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(misses.map(event => event.reason)).toEqual(['absent', 'expired'])
  })
})
