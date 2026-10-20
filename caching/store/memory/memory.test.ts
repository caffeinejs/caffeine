import { KiB } from '@caffeinejs/std/bytes'
import { Second } from '@caffeinejs/std/duration'
import { LRUCache } from 'lru-cache'
import { describe, expect, it } from 'vitest'

import { describeHTTPCacheStoreContract, elapseDate } from '../../http/store.testkit.js'
import { MemoryHTTPCacheStore, type MemoryHTTPCacheRecord } from './memory.js'

// lru-cache reads its clock from the `performance` it found as it loaded, which a faked `Date` does not move. This
// one reads `Date`, on every check.
describeHTTPCacheStoreContract(
  'MemoryHTTPCacheStore',
  () => new MemoryHTTPCacheStore(new LRUCache({ max: 500, perf: { now: () => Date.now() }, ttlResolution: 0 })),
  elapseDate,
)

describe('MemoryHTTPCacheStore', () => {
  const entry = (payload: string | Buffer, headers: Record<string, string | string[]> = {}) => ({
    payload,
    statusCode: 200,
    headers,
  })

  it('evicts least-recently-used entries once the byte budget is exceeded', async () => {
    const store = new MemoryHTTPCacheStore({ maxSize: 200 })
    const big = 'x'.repeat(150)

    await store.put('a', entry(big), { ttl: 60 * Second, tags: ['pets'] })
    await store.put('b', entry(big), { ttl: 60 * Second, tags: ['pets'] })

    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeDefined()
  })

  // The byte budget sums header values; a header may hold several.
  it('counts an array-valued header and a Buffer payload against maxSize', async () => {
    const store = new MemoryHTTPCacheStore({ maxSize: 200 })
    const big = 'x'.repeat(60)

    await store.put('a', entry('', { link: [big, big] }), { ttl: 60 * Second })
    await store.put('b', entry(Buffer.alloc(100), { 'x-note': 'y'.repeat(40) }), { ttl: 60 * Second })

    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeDefined()
  })

  // The budget is a count of bytes. An entry with no headers counts its payload and one byte more, so two of 511
  // come to exactly 1 KiB and both stay, and a byte more evicts the older.
  it('holds stored entries to exactly the maxSize budget', async () => {
    const exact = new MemoryHTTPCacheStore({ maxSize: 1 * KiB })
    await exact.put('a', entry('x'.repeat(511)), { ttl: 60 * Second })
    await exact.put('b', entry('x'.repeat(511)), { ttl: 60 * Second })

    expect(await exact.get('a')).toBeDefined()
    expect(await exact.get('b')).toBeDefined()

    const over = new MemoryHTTPCacheStore({ maxSize: 1 * KiB })
    await over.put('a', entry('x'.repeat(511)), { ttl: 60 * Second })
    await over.put('b', entry('x'.repeat(512)), { ttl: 60 * Second })

    expect(await over.get('a')).toBeUndefined()
    expect(await over.get('b')).toBeDefined()
  })

  // Text such as '64MB' was a size before sizes were counts of bytes; one left behind fails as the store is built.
  it.each([1.5, -1, 0, Number.NaN, '64MB'])('refuses the maxSize %o', size => {
    expect(() => new MemoryHTTPCacheStore({ maxSize: size as number })).toThrow(TypeError)
  })

  it('runs on a pre-built LRUCache as given', async () => {
    const lru = new LRUCache<string, MemoryHTTPCacheRecord>({ max: 1 })
    const store = new MemoryHTTPCacheStore(lru)

    await store.put('first', entry('1'), { ttl: 60 * Second })
    await store.put('second', entry('2'), { ttl: 60 * Second })

    expect(lru.size).toBe(1)
    expect(await store.get('first')).toBeUndefined()
  })

  // An eviction moves a counter and touches no entry; the entry is dropped the first time it is read.
  it('drops an entry whose tag was evicted when it is next read', async () => {
    const lru = new LRUCache<string, MemoryHTTPCacheRecord>({ max: 10 })
    const store = new MemoryHTTPCacheStore(lru)

    await store.put('k', entry('v'), { ttl: 60 * Second, tags: ['pets'] })
    await store.evictByTag('pets')
    expect(lru.size).toBe(1)

    expect(await store.get('k')).toBeUndefined()
    expect(lru.size).toBe(0)
  })
})
