import { setTimeout as sleep } from 'node:timers/promises'

import type { createClient, createCluster } from '@redis/client'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { describeCacheContract } from '../../store.testkit.js'
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
    hSetEx: async key => record('hSetEx', [key], 1),
    unlink: async key => record('unlink', [key], 1),
    incr: async key => record('incr', [key], 1),
  }
  const client: RedisCacheClient = { withTypeMapping: () => commands }

  return { client, commands, sent }
}

/**
 * The five commands the store sends, over two maps. Faithful to a server for those and for nothing else: bulk
 * replies are Buffers, a field that is absent or past its expiry reads as `null`, and `HSETEX` leaves the fields
 * it does not name alone. What a real server makes of them is `redis.e2e.ts`'s to prove.
 */
function fakeServer(): RedisCacheClient {
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, { value: Buffer; expiresAt: number }>>()
  const commands: RedisCacheCommands = {
    get: async key => {
      const value = strings.get(key)

      return value === undefined ? null : Buffer.from(value)
    },
    hmGet: async (key, fields) =>
      fields.map(name => {
        const field = hashes.get(key)?.get(name)

        return field !== undefined && field.expiresAt > Date.now() ? field.value : null
      }),
    hSetEx: async (key, fields, options) => {
      const hash = hashes.get(key) ?? new Map<string, { value: Buffer; expiresAt: number }>()
      hashes.set(key, hash)
      for (const [name, value] of Object.entries(fields)) {
        hash.set(name, {
          value: Buffer.isBuffer(value) ? value : Buffer.from(value),
          expiresAt: Date.now() + options.expiration.value,
        })
      }

      return 1
    },
    unlink: async key => (hashes.delete(key) ? 1 : 0),
    incr: async key => {
      const next = Number(strings.get(key) ?? '0') + 1
      strings.set(key, String(next))

      return next
    },
  }

  return { withTypeMapping: () => commands }
}

const entry = { payload: 'v', statusCode: 200, headers: {} }

describeCacheContract('RedisCache', () => new RedisCache(fakeServer()), { clearAll: false })
describeCacheContract('RedisCache under a hash tag', () => new RedisCache(fakeServer(), { hashTag: s => s }), {
  clearAll: false,
})

describe('RedisCache on a cluster', () => {
  it('computes slots the way a cluster does', () => {
    expect(slotOf('foo')).toBe(12182)
    expect(slotOf('{user1000}.following')).toBe(slotOf('{user1000}.followers'))
  })

  // No command names two keys, so a tag is never needed for a command to be legal. It is a placement choice:
  // whoever asks for one gets every key of the segment, its counter included, in one slot.
  it.each([
    ['a tag for each segment', (segment: string) => segment, 'pets'],
    ['a segment holding a colon', (segment: string) => segment, 'a:b'],
    ['a tag that is not the segment', () => 'shared', 'owners'],
  ])('keeps the keys of a segment in one slot under a hash tag (%s)', async (_name, hashTag, segment) => {
    const { client, sent } = recordingClient()
    const store = new RedisCache(client, { hashTag })

    await store.putMany(
      ['/pets/1', '/pets/2?x=1', 'a-very-different-key'].map(key => ({ key, entry, ttl: 60 })),
      segment,
    )
    await store.getMany(['/pets/1'], segment)
    await store.clear(segment)

    expect(new Set(sent.map(item => slotOf(item.keys[0]))).size).toBe(1)
    // The counter `clear` bumps is the one the writes and the reads go by.
    expect(sent[0].command).toBe('get')
    expect(sent.at(-1)).toEqual({ command: 'incr', keys: sent[0].keys })
  })

  it('puts two segments mapped to one tag in one slot, and tags nothing by default', async () => {
    const together = recordingClient()
    const untagged = recordingClient()

    for (const segment of ['pets', 'owners']) {
      await new RedisCache(together.client, { hashTag: () => 'shared' }).put('k', entry, 60, segment)
      await new RedisCache(untagged.client).put('k', entry, 60, segment)
    }

    expect(new Set(together.sent.map(item => slotOf(item.keys[0]))).size).toBe(1)
    expect(untagged.sent.flatMap(item => item.keys).filter(key => key.includes('{'))).toEqual([])
  })

  // A cluster answers CROSSSLOT to a command whose keys fall in two slots, and keys without a tag fall anywhere.
  it('never names more than one key in a command, a batch included', async () => {
    const { client, sent } = recordingClient()
    const store = new RedisCache(client)

    await store.getMany(['a', 'b', 'c'])
    await store.getMany(['a', 'b'], 'pets')
    await store.deleteMany(['a', 'b', 'c'])
    await store.deleteMany(['a', 'b'], 'pets')
    await store.delete('a')
    await store.delete('a', 'pets')
    await store.putMany([
      { key: 'a', entry, ttl: 60 },
      { key: 'b', entry, ttl: 60 },
    ])
    await store.put('a', entry, 60)

    for (const item of sent) {
      expect(item.keys).toHaveLength(1)
    }
    expect(sent.filter(item => item.command === 'unlink')).toHaveLength(7)
    expect(sent.at(-1)).toEqual({ command: 'hSetEx', keys: ['caffeine:cache:e:0:a'] })
  })

  // The generation is the segment's, not the entry's: a batch of any size asks for it once.
  it('reads the segment counter once for a batch of writes', async () => {
    const { client, sent } = recordingClient()

    await new RedisCache(client).putMany(
      ['a', 'b', 'c'].map(key => ({ key, entry, ttl: 60 })),
      'pets',
    )

    expect(sent.map(item => item.command)).toEqual(['get', 'hSetEx', 'hSetEx', 'hSetEx'])
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

  // A `ttl` is seconds and the server is told milliseconds. No expiry test is slow enough to notice an hour
  // that became 3.6 seconds, so the number sent is pinned here.
  it('sends the ttl to the server in milliseconds', async () => {
    const { client, commands } = recordingClient()
    const hSetEx = vi.spyOn(commands, 'hSetEx')
    const store = new RedisCache(client)

    await store.put('a', entry, '1h')
    await store.put('b', entry, 1.5)
    await store.put('c', entry, '1ms')

    expect(hSetEx.mock.calls.map(call => call[2])).toEqual([
      { expiration: { type: 'PX', value: 3_600_000 } },
      { expiration: { type: 'PX', value: 1500 } },
      { expiration: { type: 'PX', value: 1 } },
    ])
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

describe('RedisCache and the replies of the client it is given', () => {
  // The view the store asks for answers bulk replies as Buffers, but the interface is structural: a client
  // whose view hands the counter back as text, or as the number `INCR` produced, must clear just the same.
  it.each([
    ['text', (value: string) => value],
    ['a number', (value: string) => Number(value)],
  ])('compares generations when the counter comes back as %s', async (_name, reply) => {
    const server = fakeServer().withTypeMapping({} as never)
    const commands: RedisCacheCommands = {
      ...server,
      get: async key => {
        const value = await server.get(key)

        return value === null ? null : reply(String(value))
      },
    }
    const store = new RedisCache({ withTypeMapping: () => commands })

    await store.clear('pets')
    await store.put('k', entry, 60, 'pets')
    expect((await store.get('k', 'pets'))?.payload).toBe('v')

    await store.clear('pets')
    expect(await store.get('k', 'pets')).toBeUndefined()
  })
})

describe('RedisCache when the server is gone', () => {
  // The commands of a batch are in flight together and reject together. One left without a handler is an
  // unhandled rejection, which ends the process under Node's default: a store outage would take the server
  // down instead of costing it the cache.
  it('rejects a batch read without leaving a rejection unhandled', async () => {
    const down = new Error('connection lost')
    const commands: RedisCacheCommands = {
      ...recordingClient().commands,
      get: () => new Promise((_resolve, reject) => setTimeout(() => reject(down), 5)),
      hmGet: async () => {
        throw down
      },
    }
    const store = new RedisCache({ withTypeMapping: () => commands })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      await expect(store.getMany(['a', 'b'], 'pets')).rejects.toBe(down)
      await expect(store.get('a', 'pets')).rejects.toBe(down)

      // Long enough for the slower command to reject and for Node to report it.
      await sleep(30)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
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
