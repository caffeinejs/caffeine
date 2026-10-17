import { Keyv } from 'keyv'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { HTTPCacheEntry } from '../../http/store.js'
import { describeHTTPCacheStoreContract } from '../../http/store.testkit.js'
import { ErrKeyvCache, KeyvHTTPCacheStore, type KeyvHTTPCacheClient } from './index.js'

// A key-value cache that records every call, so the key layout and the bytes that go over the seam are
// assertable. `ttl === 0` means never expires, which is what both real backends do with it.
function fakeKV() {
  const data = new Map<string, { value: string; expires: number | undefined }>()
  const gets: string[] = []
  const sets: { key: string; value: string; ttl: number }[] = []

  return {
    data,
    gets,
    sets,
    async get(key: string): Promise<unknown> {
      gets.push(key)

      const record = data.get(key)
      if (record === undefined) {
        return undefined
      }

      if (record.expires !== undefined && record.expires <= Date.now()) {
        data.delete(key)
        return undefined
      }

      return record.value
    },
    async set(key: string, value: string, ttl: number): Promise<unknown> {
      sets.push({ key, value, ttl })
      data.set(key, { value, expires: ttl === 0 ? undefined : Date.now() + ttl })
      return true
    },
  }
}

describeHTTPCacheStoreContract('KeyvHTTPCacheStore', () => new KeyvHTTPCacheStore(fakeKV()))

describeHTTPCacheStoreContract('KeyvHTTPCacheStore on a Keyv', () => new KeyvHTTPCacheStore(new Keyv()))

// A Keyv is handed to the store as it comes. If this stops holding, wrap it at the call site rather than
// widening the store's seam.
it('takes a Keyv without an adapter', () => {
  expectTypeOf<Keyv>().toExtend<KeyvHTTPCacheClient>()
})

describe('KeyvHTTPCacheStore', () => {
  const entry = (payload: string | Buffer, extra?: Partial<HTTPCacheEntry>): HTTPCacheEntry => ({
    payload,
    statusCode: 200,
    headers: {},
    ...extra,
  })

  it('keeps entries and tag markers in separate namespaces', async () => {
    const kv = fakeKV()
    const store = new KeyvHTTPCacheStore(kv)

    await store.put('k', entry('v'), { ttl: 60, tags: ['pets'] })
    await store.evictByTag('pets')

    expect([...kv.data.keys()].sort()).toEqual(['caffeine:cache:e:k', 'caffeine:cache:t:pets'])
  })

  // A backend only ever has to round-trip a string, which every Keyv adapter does; bytes that are not valid
  // UTF-8 travel inside it as base64.
  it('hands the backend a string, holding a Buffer payload as base64', async () => {
    const kv = fakeKV()
    const store = new KeyvHTTPCacheStore(kv)
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80])

    await store.put('bin', entry(bytes), { ttl: 60 })

    const written = kv.sets.find(set => set.key === 'caffeine:cache:e:bin')!.value
    expect(typeof written).toBe('string')
    expect(written).toContain(bytes.toString('base64'))
  })

  // Both backends take milliseconds. Dropping the `* 1000` passes every behavioral test, since the fake and the
  // real backends would simply keep entries 1000x too briefly only under a sub-second ttl.
  it('hands the backend the ttl in milliseconds', async () => {
    const kv = fakeKV()
    const store = new KeyvHTTPCacheStore(kv)

    await store.put('k', entry('v'), { ttl: 60 })
    await store.put('sub', entry('v'), { ttl: '250ms' })

    expect(kv.sets[0].ttl).toBe(60_000)
    expect(kv.sets[1].ttl).toBe(250)
  })

  // `set(key, value, 0)` means "never expires" to both backends, so a ttl that is not positive must not reach
  // one — and there is nothing to read the markers for either.
  it('issues no call at all for a ttl that is not positive', async () => {
    const kv = fakeKV()
    const store = new KeyvHTTPCacheStore(kv)

    await store.put('zero', entry('v'), { ttl: 0, tags: ['pets'] })
    await store.put('unparsable', entry('v'), { ttl: 'ten seconds', tags: ['pets'] })

    expect(kv.sets).toEqual([])
    expect(kv.gets).toEqual([])
  })

  it('never expires a tag marker by default, and honours a tagTtl that is set', async () => {
    const kv = fakeKV()
    await new KeyvHTTPCacheStore(kv).evictByTag('pets')
    expect(kv.sets[0].ttl).toBe(0)

    const bounded = fakeKV()
    await new KeyvHTTPCacheStore(bounded, { tagTtl: '2h' }).evictByTag('pets')
    expect(bounded.sets[0].ttl).toBe(7_200_000)
  })

  // An entry written before its tag's first eviction is hidden by that eviction's marker alone. Once that marker
  // is gone it must stay hidden: the entry recorded no marker to fall back to, and serving it again would serve
  // a response the eviction was meant to take down.
  describe('an evicted entry whose marker is gone', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it.each([
      ['the fake backend', () => fakeKV()],
      ['a Keyv', () => new Keyv()],
    ])('stays hidden once the marker lapses past tagTtl, on %s', async (_backend, client) => {
      const store = new KeyvHTTPCacheStore(client(), { tagTtl: '1h' })
      vi.useFakeTimers({ toFake: ['Date'] })
      await store.put('k', entry('v'), { ttl: '1d', tags: ['pets'] })
      await store.evictByTag('pets')
      expect(await store.get('k')).toBeUndefined()

      vi.setSystemTime(Date.now() + 3_600_001)

      expect(await store.get('k')).toBeUndefined()
    })

    // A backend bounded by size, an LRU Keyv store for one, may drop a marker whatever tagTtl says.
    it('stays hidden once the backend drops the marker', async () => {
      const kv = fakeKV()
      const store = new KeyvHTTPCacheStore(kv)
      await store.put('k', entry('v'), { ttl: 60, tags: ['pets'] })
      await store.evictByTag('pets')

      kv.data.delete('caffeine:cache:t:pets')

      expect(await store.get('k')).toBeUndefined()
    })
  })

  describe('tagTtl', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    // Every other duration in the package fails loud. One that is not a duration would otherwise read as
    // "never expires", the opposite of the bound on the marker keyspace that setting it asks for.
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '1 hour', '-5s', ''])('refuses %s', tagTtl => {
      expect(() => new KeyvHTTPCacheStore(fakeKV(), { tagTtl })).toThrow(ErrKeyvCache)
    })

    it('names the value it refuses', () => {
      expect(() => new KeyvHTTPCacheStore(fakeKV(), { tagTtl: '1 hour' })).toThrow(
        'Cannot create a Keyv cache with the tagTtl "1 hour": it is not a non-negative duration',
      )
    })

    it.each([0, '0s', '2h', 7200])('takes %s', tagTtl => {
      expect(() => new KeyvHTTPCacheStore(fakeKV(), { tagTtl })).not.toThrow()
    })

    // The documented direction of failure: a marker that lapses while an entry stored under it is still alive
    // takes the entry down with it. A hit is lost; nothing meant to be gone is served.
    it('takes an entry down with the marker it was stored under when that lapses', async () => {
      const store = new KeyvHTTPCacheStore(fakeKV(), { tagTtl: '1h' })
      vi.useFakeTimers({ toFake: ['Date'] })
      await store.evictByTag('pets')
      await store.put('k', entry('v'), { ttl: '1d', tags: ['pets'] })
      expect((await store.get('k'))?.payload).toBe('v')

      vi.setSystemTime(Date.now() + 3_600_001)

      expect(await store.get('k')).toBeUndefined()
    })

    // `0` is the documented "never expires": the marker outlives anything stored under it.
    it('keeps a marker for good at 0', async () => {
      const store = new KeyvHTTPCacheStore(fakeKV(), { tagTtl: 0 })
      vi.useFakeTimers({ toFake: ['Date'] })
      await store.evictByTag('pets')
      await store.put('k', entry('v'), { ttl: '30d', tags: ['pets'] })

      vi.setSystemTime(Date.now() + 29 * 86_400_000)

      expect((await store.get('k'))?.payload).toBe('v')
    })
  })

  it('uses the prefix verbatim, and puts nothing in front for an empty one', async () => {
    const kv = fakeKV()
    await new KeyvHTTPCacheStore(kv, { prefix: 'app|' }).put('k', entry('v'), { ttl: 60 })
    expect(kv.sets[0].key).toBe('app|e:k')

    const bare = fakeKV()
    await new KeyvHTTPCacheStore(bare, { prefix: '' }).put('k', entry('v'), { ttl: 60 })
    expect(bare.sets[0].key).toBe('e:k')
  })
})
