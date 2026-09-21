import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import type { Cache, CacheEntry } from './store.js'

export interface CacheContractCapabilities {
  /** Whether `clear()` without a segment empties the store. A store that refuses that form rejects instead. */
  clearAll: boolean
}

const entry = (payload: string | Buffer, extra?: Partial<CacheEntry>): CacheEntry => ({
  payload,
  statusCode: 200,
  headers: {},
  ...extra,
})

/**
 * What every {@link Cache} owes the HTTP cache, stated once. `factory` hands back a store nothing else writes
 * to, so a case never reads another one's entries.
 */
export function describeCacheContract(
  name: string,
  factory: () => Cache | Promise<Cache>,
  capabilities: CacheContractCapabilities,
): void {
  describe(`${name}: Cache contract`, () => {
    it('reads back what was put, field by field', async () => {
      const store = await factory()
      const full: CacheEntry = {
        payload: '{"id":1}',
        statusCode: 404,
        etag: '"abc"',
        lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        storedAt: 1_700_000_000_000,
        headers: { 'content-type': 'application/json', link: ['</a>; rel="next"', '</b>; rel="prev"'] },
      }

      await store.put('k', full, 60)

      expect(await store.get('k')).toEqual(full)
    })

    it('leaves the optional fields of the entry it replaces behind', async () => {
      const store = await factory()
      await store.put('k', entry('old', { etag: '"old"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' }), 60)

      await store.put('k', entry('new'), 60)

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

      await store.put('bin', entry(bytes), 60)
      await store.put('text', entry('héllo'), 60)

      const bin = await store.get('bin')
      expect(Buffer.isBuffer(bin?.payload)).toBe(true)
      expect(Buffer.compare(bin!.payload as Buffer, bytes)).toBe(0)
      expect((await store.get('text'))?.payload).toBe('héllo')
    })

    it('reads an absent key as undefined', async () => {
      const store = await factory()

      expect(await store.get('nothing')).toBeUndefined()
    })

    it('reads an entry past its ttl as undefined', async () => {
      const store = await factory()
      await store.put('k', entry('v'), '10ms')

      await sleep(40)

      expect(await store.get('k')).toBeUndefined()
      expect(await store.getMany(['k'])).toEqual([undefined])
    })

    // A ttl of zero is "do not keep this", never "keep this forever".
    it('stores nothing under a ttl that is not positive', async () => {
      const store = await factory()

      await store.put('zero', entry('v'), 0)
      await store.put('unparsable', entry('v'), 'ten seconds')
      await store.putMany([
        { key: 'skipped', entry: entry('v'), ttl: 0 },
        { key: 'kept', entry: entry('v'), ttl: 60 },
      ])

      expect(await store.getMany(['zero', 'unparsable', 'skipped'])).toEqual([undefined, undefined, undefined])
      expect((await store.get('kept'))?.payload).toBe('v')
    })

    it('answers getMany in key order, as long as the keys, duplicates included', async () => {
      const store = await factory()
      await store.put('a', entry('A'), 60)
      await store.put('b', entry('B'), 60)

      const read = await store.getMany(['b', 'missing', 'a', 'b'])

      expect(read.map(e => e?.payload)).toEqual(['B', undefined, 'A', 'B'])
      expect(await store.getMany([])).toEqual([])
    })

    it('gives each putMany item its own lifetime', async () => {
      const store = await factory()

      await store.putMany([
        { key: 'short', entry: entry('S'), ttl: '10ms' },
        { key: 'long', entry: entry('L'), ttl: '1h' },
      ])
      await sleep(40)

      expect((await store.getMany(['short', 'long'])).map(e => e?.payload)).toEqual([undefined, 'L'])
    })

    it('keeps segments apart for every verb', async () => {
      const store = await factory()
      await store.put('k', entry('in-pets'), 60, 'pets')
      await store.putMany([{ key: 'k', entry: entry('in-owners'), ttl: 60 }], 'owners')

      expect((await store.get('k', 'pets'))?.payload).toBe('in-pets')
      expect((await store.getMany(['k'], 'owners'))[0]?.payload).toBe('in-owners')
      expect(await store.get('k')).toBeUndefined()

      await store.delete('k', 'owners')

      expect(await store.get('k', 'owners')).toBeUndefined()
      expect((await store.get('k', 'pets'))?.payload).toBe('in-pets')
    })

    it('deletes every key of deleteMany and nothing else', async () => {
      const store = await factory()
      await store.putMany(
        ['a', 'b', 'c'].map(key => ({ key, entry: entry(key), ttl: 60 })),
        'seg',
      )

      await store.deleteMany(['a', 'c', 'never-stored'], 'seg')
      await store.deleteMany([], 'seg')

      expect((await store.getMany(['a', 'b', 'c'], 'seg')).map(e => e?.payload)).toEqual([undefined, 'b', undefined])
    })

    it('clears one segment and leaves the others, and the unsegmented entries, alone', async () => {
      const store = await factory()
      await store.put('k', entry('pets'), 60, 'pets')
      await store.put('k', entry('owners'), 60, 'owners')
      await store.put('k', entry('none'), 60)

      await store.clear('pets')

      expect(await store.get('k', 'pets')).toBeUndefined()
      expect((await store.get('k', 'owners'))?.payload).toBe('owners')
      expect((await store.get('k'))?.payload).toBe('none')

      await store.put('k', entry('pets-again'), 60, 'pets')
      expect((await store.get('k', 'pets'))?.payload).toBe('pets-again')
    })

    // Segment and key are joined into one store key somewhere: the join must not let one name reach into another.
    it('does not let a segment name reach into another segment or into unsegmented keys', async () => {
      const store = await factory()
      await store.put('k', entry('a:b'), 60, 'a:b')
      await store.put('b:k', entry('a'), 60, 'a')
      await store.put('users:1', entry('unsegmented'), 60)

      expect(await store.get('1', 'users')).toBeUndefined()

      await store.clear('a')

      expect(await store.get('b:k', 'a')).toBeUndefined()
      expect((await store.get('k', 'a:b'))?.payload).toBe('a:b')
      expect((await store.get('users:1'))?.payload).toBe('unsegmented')
    })

    if (capabilities.clearAll) {
      it('empties the store on a clear without a segment', async () => {
        const store = await factory()
        await store.put('k', entry('seg'), 60, 'seg')
        await store.put('k', entry('none'), 60)

        await store.clear()

        expect(await store.get('k', 'seg')).toBeUndefined()
        expect(await store.get('k')).toBeUndefined()
      })
    } else {
      it('refuses a clear without a segment, and removes nothing', async () => {
        const store = await factory()
        await store.put('k', entry('none'), 60)

        await expect(store.clear()).rejects.toThrow()

        expect((await store.get('k'))?.payload).toBe('none')
      })
    }
  })
}
