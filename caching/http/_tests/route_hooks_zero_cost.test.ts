import { Controller, Get, Post, type WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/node'
import { Minute } from '@caffeinejs/std/duration'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import {
  CacheControl,
  CacheInvalidate,
  HTTPCaching,
  type HTTPCacheCallOptions,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCachePutOptions,
  type HTTPCacheStore,
} from '../index.js'

/**
 * What the cache does to a route that does not use it: nothing. The cache attaches per route, from the server's
 * `onRoute` hook, so a route in the same application that declared nothing is never handled by it: no store call, no
 * event, no status header. This is the guard against a later change making a cache hook unconditional.
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

// Counts what the cache asks of the store.
class CountingStore implements HTTPCacheStore {
  readonly #inner = new MemoryHTTPCacheStore()
  gets = 0
  evicts = 0

  get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    this.gets++
    return this.#inner.get(key, options)
  }

  put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    return this.#inner.put(key, entry, options)
  }

  evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    this.evicts++
    return this.#inner.evictByTag(tags, options)
  }
}

const store = new CountingStore()
const events: string[] = []
let app: WebApplication

beforeAll(async () => {
  app = createWebApplication().with(
    HTTPCaching(b =>
      b.store(store).observer({
        onHit: () => void events.push('hit'),
        onMiss: () => void events.push('miss'),
        onStore: () => void events.push('store'),
        onBypass: () => void events.push('bypass'),
        onInvalidate: () => void events.push('invalidate'),
      }),
    ),
  )
  await app.bootstrap()
})

afterAll(async () => {
  await app?.close()
})

beforeEach(() => {
  store.gets = 0
  store.evicts = 0
  events.length = 0
})

describe('a route that uses no feature of the cache', () => {
  it('is left alone: no store call, no event, no status header', async () => {
    const res = await app.request('/hooks/plain')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe(null)
    expect(store.gets).toBe(0)
    expect(events).toEqual([])
  })
})

describe('the routes that use it', () => {
  // The guard that the counting store and the observer see what a cached route does.
  it('reads the store and reports on a @CacheControl route', async () => {
    await app.request('/hooks/cached')

    expect(store.gets).toBe(1)
    expect(events).toEqual(['miss', 'store'])
  })

  it('only writes its headers on a @CacheControl(false) route: it has nothing to serve', async () => {
    const res = await app.request('/hooks/uncached')

    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0, must-revalidate, proxy-revalidate')
    expect(store.gets).toBe(0)
  })

  it('only evicts on a @CacheInvalidate route', async () => {
    await app.request('/hooks/mutate', { method: 'POST' })

    expect(store.evicts).toBe(1)
    expect(store.gets).toBe(0)
    expect(events).toEqual(['invalidate'])
  })
})
