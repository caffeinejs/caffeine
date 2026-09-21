import type { createClient, createCluster } from '@redis/client'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { ErrRedisCache, RedisCache, type RedisCacheClient, type RedisCacheCommands } from './index.js'

// CRC16/XMODEM over the hash tag when the key has one, modulo 16384: how a cluster places a key.
function slotOf(key: string): number {
  const open = key.indexOf('{')
  const end = open === -1 ? -1 : key.indexOf('}', open + 1)
  const hashed = end > open + 1 ? key.slice(open + 1, end) : key

  let crc = 0
  for (const byte of Buffer.from(hashed)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }

  return crc % 16384
}

/** Records every command with the keys it named, and answers as an empty server would. */
function recordingClient() {
  const sent: { command: string; keys: string[] }[] = []
  const record = <T>(command: string, keys: string[], reply: T): T => {
    sent.push({ command, keys })
    return reply
  }
  const commands: RedisCacheCommands = {
    get: async key => record('get', [key], null),
    hmGet: async (key, fields) =>
      record(
        'hmGet',
        [key],
        fields.map(() => null),
      ),
    eval: async (_script, options) => record('eval', options.keys, 1),
    unlink: async key => record('unlink', [key], 1),
    incr: async key => record('incr', [key], 1),
  }
  const client: RedisCacheClient = { withTypeMapping: () => commands }

  return { client, sent }
}

const entry = { payload: 'v', statusCode: 200, headers: {} }

describe('RedisCache on a cluster', () => {
  it('computes slots the way a cluster does', () => {
    expect(slotOf('foo')).toBe(12182)
    expect(slotOf('{user1000}.following')).toBe(slotOf('{user1000}.followers'))
  })

  // A cluster answers CROSSSLOT to a command whose keys fall in two slots. The write script names two keys, so
  // they must share one, for any segment and any key.
  it.each([
    ['the default tag', undefined, 'pets'],
    ['a segment holding a colon', undefined, 'a:b'],
    ['a tag several segments share', () => 'shared', 'owners'],
  ])('writes an entry and its segment counter into one slot (%s)', async (_name, hashTag, segment) => {
    const { client, sent } = recordingClient()
    const store = new RedisCache(client, { hashTag })

    await store.putMany(
      ['/pets/1', '/pets/2?x=1', 'a-very-different-key'].map(key => ({ key, entry, ttl: 60 })),
      segment,
    )
    await store.clear(segment)

    for (const { keys } of sent.filter(item => item.command === 'eval')) {
      expect(keys).toHaveLength(2)
      expect(slotOf(keys[0])).toBe(slotOf(keys[1]))
    }
    // The counter `clear` bumps is the one the script read.
    expect(sent.at(-1)).toEqual({ command: 'incr', keys: [sent[0].keys[1]] })
  })

  it('puts two segments mapped to one tag in one slot, and leaves segments apart by default', async () => {
    const together = recordingClient()
    const apart = recordingClient()

    for (const segment of ['pets', 'owners']) {
      await new RedisCache(together.client, { hashTag: () => 'shared' }).put('k', entry, 60, segment)
      await new RedisCache(apart.client).put('k', entry, 60, segment)
    }

    expect(slotOf(together.sent[0].keys[0])).toBe(slotOf(together.sent[1].keys[0]))
    expect(slotOf(apart.sent[0].keys[0])).not.toBe(slotOf(apart.sent[1].keys[0]))
  })

  // Every other command names one key, so nothing about it can cross a slot — a batch included.
  it('never names more than one key outside the write script', async () => {
    const { client, sent } = recordingClient()
    const store = new RedisCache(client)

    await store.getMany(['a', 'b', 'c'])
    await store.getMany(['a', 'b'], 'pets')
    await store.deleteMany(['a', 'b', 'c'])
    await store.deleteMany(['a', 'b'], 'pets')
    await store.put('a', entry, 60)

    for (const item of sent) {
      expect(item.keys).toHaveLength(1)
    }
    expect(sent.filter(item => item.command === 'unlink')).toHaveLength(5)
    expect(sent.at(-1)).toEqual({ command: 'eval', keys: ['caffeine:cache:e:0:a'] })
  })

  it('sends nothing for an empty batch, or for a ttl that is not positive', async () => {
    const { client, sent } = recordingClient()
    const store = new RedisCache(client)

    await store.getMany([])
    await store.deleteMany([])
    await store.putMany([])
    await store.put('a', entry, 0)

    expect(sent).toEqual([])
  })

  // Redis hashes the first `{...}` of a key: a brace of the caller's would decide the slot instead of the tag.
  it('refuses a brace in the prefix or in a hash tag', async () => {
    const { client } = recordingClient()

    expect(() => new RedisCache(client, { prefix: 'app:{x}:' })).toThrow(ErrRedisCache)
    await expect(new RedisCache(client, { hashTag: () => 'a}b' }).put('k', entry, 60, 'pets')).rejects.toThrow(
      'Cannot use the hash tag "a}b" for segment "pets": it holds a brace',
    )
  })

  it('refuses a clear without a segment, and sends nothing', async () => {
    const { client, sent } = recordingClient()

    await expect(new RedisCache(client).clear()).rejects.toThrow(ErrRedisCache)
    expect(sent).toEqual([])
  })
})

describe('RedisCacheClient', () => {
  // The interface is structural so a client of any RESP version or type mapping fits. What it must never do is
  // stop fitting the two clients node-redis hands out.
  it('is satisfied by a node-redis client and by a node-redis cluster client', () => {
    expectTypeOf<ReturnType<typeof createClient>>().toExtend<RedisCacheClient>()
    expectTypeOf<ReturnType<typeof createCluster>>().toExtend<RedisCacheClient>()
  })
})
