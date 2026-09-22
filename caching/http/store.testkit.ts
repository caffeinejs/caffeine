import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import type { HTTPCacheEntry, HTTPCacheStore } from './store.js'

const entry = (payload: string | Buffer, extra?: Partial<HTTPCacheEntry>): HTTPCacheEntry => ({
  payload,
  statusCode: 200,
  headers: {},
  ...extra,
})

/**
 * What every {@link HTTPCacheStore} owes the HTTP cache, stated once. `factory` hands back a store nothing
 * else writes to, so a case never reads another one's entries.
 */
export function describeHTTPCacheStoreContract(
  name: string,
  factory: () => HTTPCacheStore | Promise<HTTPCacheStore>,
): void {
  describe(`${name}: HTTPCacheStore contract`, () => {
    it('reads back what was put, field by field', async () => {
      const store = await factory()
      const full: HTTPCacheEntry = {
        payload: '{"id":1}',
        statusCode: 404,
        etag: '"abc"',
        lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        storedAt: 1_700_000_000_000,
        headers: { 'content-type': 'application/json', link: ['</a>; rel="next"', '</b>; rel="prev"'] },
      }

      await store.put('k', full, { ttl: 60, tags: ['pets', 'all'] })

      expect(await store.get('k')).toEqual(full)
      expect(await store.get('k', { tags: ['pets', 'all'] })).toEqual(full)
    })

    it('leaves the optional fields of the entry it replaces behind', async () => {
      const store = await factory()
      await store.put('k', entry('old', { etag: '"old"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' }), {
        ttl: 60,
      })

      await store.put('k', entry('new'), { ttl: 60 })

      const read = await store.get('k')
      expect(read?.payload).toBe('new')
      expect(read?.etag).toBeUndefined()
      expect(read?.lastModified).toBeUndefined()
    })

    // A Buffer is what a handler that answers with bytes hands over: it must come back as bytes, and the same
    // ones, including sequences that are not valid UTF-8.
    it('keeps a Buffer payload a Buffer, byte for byte, and a string payload a string', async () => {
      const store = await factory()
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a])

      await store.put('bin', entry(bytes), { ttl: 60 })
      await store.put('text', entry('héllo'), { ttl: 60 })

      const bin = await store.get('bin')
      expect(Buffer.isBuffer(bin?.payload)).toBe(true)
      expect(Buffer.compare(bin!.payload as Buffer, bytes)).toBe(0)
      expect((await store.get('text'))?.payload).toBe('héllo')
    })

    it('reads an absent key as undefined', async () => {
      const store = await factory()

      expect(await store.get('nothing')).toBeUndefined()
      expect(await store.get('nothing', { tags: ['pets'] })).toBeUndefined()
    })

    it('reads an entry past its ttl as undefined', async () => {
      const store = await factory()
      await store.put('k', entry('v'), { ttl: '10ms', tags: ['pets'] })

      await sleep(40)

      expect(await store.get('k')).toBeUndefined()
    })

    // A ttl of zero is "do not keep this", never "keep this forever".
    it('stores nothing under a ttl that is not positive', async () => {
      const store = await factory()

      await store.put('zero', entry('v'), { ttl: 0 })
      await store.put('unparsable', entry('v'), { ttl: 'ten seconds' })
      await store.put('kept', entry('v'), { ttl: 60 })

      expect(await store.get('zero')).toBeUndefined()
      expect(await store.get('unparsable')).toBeUndefined()
      expect((await store.get('kept'))?.payload).toBe('v')
    })

    it('hides every entry carrying an evicted tag, and no other', async () => {
      const store = await factory()
      await store.put('pet-1', entry('1'), { ttl: 60, tags: ['pets'] })
      await store.put('pet-2', entry('2'), { ttl: 60, tags: ['pets'] })
      await store.put('owner-1', entry('o'), { ttl: 60, tags: ['owners'] })
      await store.put('plain', entry('p'), { ttl: 60 })

      await store.evictByTag('pets')

      expect(await store.get('pet-1')).toBeUndefined()
      expect(await store.get('pet-2', { tags: ['pets'] })).toBeUndefined()
      expect((await store.get('owner-1'))?.payload).toBe('o')
      expect((await store.get('plain'))?.payload).toBe('p')
    })

    it('takes an entry with several tags down with any one of them', async () => {
      const store = await factory()
      await store.put('by-a', entry('a'), { ttl: 60, tags: ['a', 'b'] })
      await store.put('by-b', entry('b'), { ttl: 60, tags: ['a', 'b'] })

      await store.evictByTag('a')
      expect(await store.get('by-a')).toBeUndefined()

      await store.put('by-b', entry('b2'), { ttl: 60, tags: ['a', 'b'] })
      await store.evictByTag(['b'])
      expect(await store.get('by-b')).toBeUndefined()
    })

    it('reads an entry put again after an eviction', async () => {
      const store = await factory()
      await store.put('k', entry('before'), { ttl: 60, tags: ['pets'] })
      await store.evictByTag('pets')

      await store.put('k', entry('after'), { ttl: 60, tags: ['pets'] })

      expect((await store.get('k'))?.payload).toBe('after')
      expect((await store.get('k', { tags: ['pets'] }))?.payload).toBe('after')
    })

    it('evicts several tags at once, and nothing for an empty list or a tag nothing carries', async () => {
      const store = await factory()
      await store.put('a', entry('a'), { ttl: 60, tags: ['a'] })
      await store.put('b', entry('b'), { ttl: 60, tags: ['b'] })
      await store.put('c', entry('c'), { ttl: 60, tags: ['c'] })

      await store.evictByTag([])
      await store.evictByTag('never-used')
      expect((await store.get('a'))?.payload).toBe('a')

      await store.evictByTag(['a', 'b'])
      expect(await store.get('a')).toBeUndefined()
      expect(await store.get('b')).toBeUndefined()
      expect((await store.get('c'))?.payload).toBe('c')
    })

    it('never touches an entry stored without tags', async () => {
      const store = await factory()
      await store.put('plain', entry('p'), { ttl: 60 })

      await store.evictByTag(['plain', 'pets', 'all'])

      expect((await store.get('plain'))?.payload).toBe('p')
    })

    // The hint only tells a store where to look first. Naming a tag the entry does not carry, or leaving out one
    // it does, must not change the answer.
    it('answers the same whatever the tags hint says', async () => {
      const store = await factory()
      await store.put('k', entry('v'), { ttl: 60, tags: ['pets', 'all'] })

      expect((await store.get('k', { tags: ['pets'] }))?.payload).toBe('v')
      expect((await store.get('k', { tags: ['unrelated'] }))?.payload).toBe('v')
      expect((await store.get('k', { tags: [] }))?.payload).toBe('v')

      await store.evictByTag('all')

      expect(await store.get('k', { tags: ['pets'] })).toBeUndefined()
      expect(await store.get('k', { tags: ['unrelated'] })).toBeUndefined()
      expect(await store.get('k')).toBeUndefined()
    })

    it('rejects a call whose signal is already aborted, and does nothing for it', async () => {
      const store = await factory()
      await store.put('k', entry('v'), { ttl: 60, tags: ['pets'] })
      const signal = AbortSignal.abort()

      await expect(store.get('k', { signal })).rejects.toThrow()
      await expect(store.put('other', entry('o'), { ttl: 60, signal })).rejects.toThrow()
      await expect(store.evictByTag('pets', { signal })).rejects.toThrow()

      expect(await store.get('other')).toBeUndefined()
      expect((await store.get('k'))?.payload).toBe('v')
    })

    it('takes a signal that is not aborted in its stride', async () => {
      const store = await factory()
      const signal = new AbortController().signal

      await store.put('k', entry('v'), { ttl: 60, tags: ['pets'], signal })
      expect((await store.get('k', { signal, tags: ['pets'] }))?.payload).toBe('v')

      await store.evictByTag('pets', { signal })
      expect(await store.get('k', { signal })).toBeUndefined()
    })
  })
}
