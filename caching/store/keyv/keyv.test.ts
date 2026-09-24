import { Keyv } from 'keyv'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { HTTPCacheEntry } from '../../http/store.js'
import { describeHTTPCacheStoreContract } from '../../http/store.testkit.js'
import { KeyValueHTTPCacheStore, type KeyValueHTTPCacheClient } from './keyv.js'

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

describeHTTPCacheStoreContract('KeyValueHTTPCacheStore', () => new KeyValueHTTPCacheStore(fakeKV()))

describeHTTPCacheStoreContract('KeyValueHTTPCacheStore on a Keyv', () => new KeyValueHTTPCacheStore(new Keyv()))

// A Keyv is handed to the store as it comes. If this stops holding, wrap it at the call site rather than
// widening the store's seam.
it('takes a Keyv without an adapter', () => {
  expectTypeOf<Keyv>().toExtend<KeyValueHTTPCacheClient>()
})

describe('KeyValueHTTPCacheStore', () => {
  const entry = (payload: string | Buffer, extra?: Partial<HTTPCacheEntry>): HTTPCacheEntry => ({
    payload,
    statusCode: 200,
    headers: {},
    ...extra,
  })

  const envelopeAt = (kv: ReturnType<typeof fakeKV>, key: string) =>
    JSON.parse(kv.data.get(key)!.value) as Record<string, unknown>

  it('keeps entries and tag markers in separate namespaces', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)

    await store.put('k', entry('v'), { ttl: 60, tags: ['pets'] })
    await store.evictByTag('pets')

    expect([...kv.data.keys()]).toEqual(['caffeine:cache:e:k', 'caffeine:cache:t:pets'])
  })

  // Without the `e:`/`t:` split an entry and a tag of the same name share a key, so evicting the tag would
  // overwrite the entry — and the entry is not even supposed to carry that tag.
  it('does not touch an entry whose key matches the evicted tag', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)
    await store.put('plain', entry('p'), { ttl: 60 })

    await store.evictByTag('plain')

    expect((await store.get('plain'))?.payload).toBe('p')
    expect(kv.data.has('caffeine:cache:e:plain')).toBe(true)
    expect(kv.data.has('caffeine:cache:t:plain')).toBe(true)
  })

  // A backend only ever has to round-trip a string; bytes that are not valid UTF-8 survive as base64.
  it('stores a Buffer payload as base64 and a string payload verbatim', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80])

    await store.put('bin', entry(bytes), { ttl: 60 })
    await store.put('text', entry('héllo'), { ttl: 60 })

    expect(envelopeAt(kv, 'caffeine:cache:e:bin')).toMatchObject({ k: 'b', p: bytes.toString('base64') })
    expect(envelopeAt(kv, 'caffeine:cache:e:text')).toMatchObject({ k: 's', p: 'héllo' })
  })

  // The whole envelope is written on every put, so an entry can never inherit a field from the one it replaces.
  it('writes the envelope whole, leaving no field of the entry it replaces', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)
    await store.put('k', entry('old', { etag: '"old"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' }), {
      ttl: 60,
    })

    await store.put('k', entry('new'), { ttl: 60 })

    const stored = envelopeAt(kv, 'caffeine:cache:e:k')
    expect(stored).not.toHaveProperty('t')
    expect(stored).not.toHaveProperty('l')
  })

  // A marker is unique per eviction, so it can never come round to a value an entry already recorded — the
  // hazard a counter has under an eviction policy that may drop it.
  it('writes a different marker on every eviction of the same tag', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)

    await store.evictByTag('pets')
    await store.evictByTag('pets')

    const [first, second] = kv.sets
    expect(first.key).toBe('caffeine:cache:t:pets')
    expect(second.key).toBe('caffeine:cache:t:pets')
    expect(first.value).not.toBe(second.value)
  })

  // Both backends take milliseconds. Dropping the `* 1000` passes every behavioral test, since the fake and the
  // real backends would simply keep entries 1000x too briefly only under a sub-second ttl.
  it('converts the ttl to milliseconds', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)

    await store.put('k', entry('v'), { ttl: 60 })
    await store.put('sub', entry('v'), { ttl: '250ms' })

    expect(kv.sets[0].ttl).toBe(60_000)
    expect(kv.sets[1].ttl).toBe(250)
  })

  // `set(key, value, 0)` means "never expires" to both backends, so a ttl that is not positive must not reach
  // one — and there is nothing to read the markers for either.
  it('issues no call at all for a ttl that is not positive', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv)

    await store.put('zero', entry('v'), { ttl: 0, tags: ['pets'] })
    await store.put('unparsable', entry('v'), { ttl: 'ten seconds', tags: ['pets'] })

    expect(kv.sets).toEqual([])
    expect(kv.gets).toEqual([])
  })

  it('never expires a tag marker by default, and honours a tagTtl that is set', async () => {
    const kv = fakeKV()
    await new KeyValueHTTPCacheStore(kv).evictByTag('pets')
    expect(kv.sets[0].ttl).toBe(0)

    const bounded = fakeKV()
    await new KeyValueHTTPCacheStore(bounded, { tagTtl: '2h' }).evictByTag('pets')
    expect(bounded.sets[0].ttl).toBe(7_200_000)
  })

  // The documented direction of failure: a marker lost while an entry written under it is still alive costs a
  // hit, and never serves an entry that was meant to be gone.
  it('reads an entry as absent when the marker it recorded has expired', async () => {
    const kv = fakeKV()
    const store = new KeyValueHTTPCacheStore(kv, { tagTtl: '1h' })
    await store.evictByTag('pets')
    await store.put('k', entry('v'), { ttl: 60, tags: ['pets'] })
    expect((await store.get('k'))?.payload).toBe('v')

    kv.data.delete('caffeine:cache:t:pets')

    expect(await store.get('k')).toBeUndefined()
  })

  it('uses the prefix verbatim, and puts nothing in front for an empty one', async () => {
    const kv = fakeKV()
    await new KeyValueHTTPCacheStore(kv, { prefix: 'app|' }).put('k', entry('v'), { ttl: 60 })
    expect(kv.sets[0].key).toBe('app|e:k')

    const bare = fakeKV()
    await new KeyValueHTTPCacheStore(bare, { prefix: '' }).put('k', entry('v'), { ttl: 60 })
    expect(bare.sets[0].key).toBe('e:k')
  })
})
