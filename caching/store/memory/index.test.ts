import { LRUCache } from 'lru-cache'
import { describe, expect, it } from 'vitest'

import { describeHTTPCacheStoreContract } from '../../http/store.testkit.js'
import type { CacheEntry } from '../../store.js'
import { describeCacheContract } from '../../store.testkit.js'
import { MemoryCache, MemoryHTTPCacheStore, type MemoryHTTPCacheRecord } from './index.js'

describeHTTPCacheStoreContract('MemoryHTTPCacheStore', () => new MemoryHTTPCacheStore())

describe('MemoryHTTPCacheStore', () => {
  const entry = (payload: string | Buffer, headers: Record<string, string | string[]> = {}) => ({
    payload,
    statusCode: 200,
    headers,
  })

  it('evicts least-recently-used entries once the byte budget is exceeded', async () => {
    const store = new MemoryHTTPCacheStore({ maxSize: 200 })
    const big = 'x'.repeat(150)

    await store.put('a', entry(big), { ttl: 60, tags: ['pets'] })
    await store.put('b', entry(big), { ttl: 60, tags: ['pets'] })

    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeDefined()
  })

  // The byte budget sums header values; a header may hold several.
  it('counts an array-valued header and a Buffer payload against maxSize', async () => {
    const store = new MemoryHTTPCacheStore({ maxSize: 200 })
    const big = 'x'.repeat(60)

    await store.put('a', entry('', { link: [big, big] }), { ttl: 60 })
    await store.put('b', entry(Buffer.alloc(100), { 'x-note': 'y'.repeat(40) }), { ttl: 60 })

    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeDefined()
  })

  it('runs on a pre-built LRUCache as given', async () => {
    const lru = new LRUCache<string, MemoryHTTPCacheRecord>({ max: 1 })
    const store = new MemoryHTTPCacheStore(lru)

    await store.put('first', entry('1'), { ttl: 60 })
    await store.put('second', entry('2'), { ttl: 60 })

    expect(lru.size).toBe(1)
    expect(await store.get('first')).toBeUndefined()
  })

  // An eviction moves a counter and touches no entry; the entry is dropped the first time it is read.
  it('drops an entry whose tag was evicted when it is next read', async () => {
    const lru = new LRUCache<string, MemoryHTTPCacheRecord>({ max: 10 })
    const store = new MemoryHTTPCacheStore(lru)

    await store.put('k', entry('v'), { ttl: 60, tags: ['pets'] })
    await store.evictByTag('pets')
    expect(lru.size).toBe(1)

    expect(await store.get('k')).toBeUndefined()
    expect(lru.size).toBe(0)
  })
})

describeCacheContract('MemoryCache', () => new MemoryCache(), { clearAll: true })

describe('MemoryCache', () => {
  it('evicts least-recently-used entries once the byte budget is exceeded', async () => {
    const store = new MemoryCache({ maxSize: 200 })
    const big = 'x'.repeat(150)

    await store.put('a', { payload: big, statusCode: 200, headers: {} }, 60, 'seg')
    await store.put('b', { payload: big, statusCode: 200, headers: {} }, 60, 'seg')

    expect(await store.get('a', 'seg')).toBeUndefined()
    expect(await store.get('b', 'seg')).toBeDefined()
  })

  // The byte budget sums header values; a header may hold several.
  it('counts an array-valued header against maxSize', async () => {
    const store = new MemoryCache({ maxSize: 200 })
    const big = 'x'.repeat(60)

    await store.put('a', { payload: '', statusCode: 200, headers: { link: [big, big] } }, 60)
    await store.put('b', { payload: '', statusCode: 200, headers: { link: [big, big] } }, 60)

    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeDefined()
  })

  // Bytes are bytes: a binary payload and a plain header weigh against the budget like any other.
  it('counts a Buffer payload and a text header against maxSize', async () => {
    const store = new MemoryCache({ maxSize: 200 })
    const entry = { payload: Buffer.alloc(100), statusCode: 200, headers: { 'x-note': 'y'.repeat(40) } }

    await store.put('a', entry, 60)
    await store.put('b', entry, 60)

    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeDefined()
  })

  it('runs on a pre-built LRUCache as given', async () => {
    const lru = new LRUCache<string, CacheEntry>({ max: 1 })
    const store = new MemoryCache(lru)

    await store.put('first', { payload: '1', statusCode: 200, headers: {} }, 60)
    await store.put('second', { payload: '2', statusCode: 200, headers: {} }, 60)

    expect(lru.size).toBe(1)
    expect(await store.get('first')).toBeUndefined()
  })
})
