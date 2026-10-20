import { Second, Hour, Millisecond } from '@caffeinejs/std/duration'
import { AbortError, RESP_TYPES, createClient, type createCluster } from '@redis/client'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { describeHTTPCacheStoreContract, elapseDate } from '../../http/store.testkit.js'
import {
  ErrRedisCache,
  RedisHTTPCacheStore,
  type RedisHTTPCacheClient,
  type RedisHTTPCacheCommands,
  type RedisHTTPCacheView,
} from './index.js'

interface SentCommand {
  command: string
  key: string
  /** How many replies had settled when the command was issued: `0` for everything in the first batch. */
  batch: number
  signal: AbortSignal | undefined
}

/**
 * The four commands `RedisHTTPCacheStore` sends, over two maps, shaped like a single-server client (a view with
 * `withAbortSignal`) or like a cluster client (without it). Records every command with the signal it was bound
 * to and the batch it was issued in. `hold()` makes the server stop answering, as a paused one would; a held
 * command settles only through its signal. Like a node-redis client, it answers bulk replies as Buffers only to
 * a view made with the Buffer type mapping, and as text otherwise. Faithful to a server for these commands and
 * nothing else.
 */
function fakeHTTPServer(
  shape: 'client' | 'cluster' = 'client',
  counterAs: (value: string) => unknown = v => Buffer.from(v),
) {
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, { value: Buffer; expiresAt: number }>>()
  const sent: SentCommand[] = []
  const withCommandOptions = vi.fn()
  let settled = 0
  let held = false

  function commandsWith(signal: AbortSignal | undefined, buffers: boolean): RedisHTTPCacheCommands {
    const run = <T>(command: string, key: string, reply: () => T): Promise<T> => {
      sent.push({ command, key, batch: settled, signal })
      if (signal?.aborted) {
        return Promise.reject(new AbortError())
      }

      return new Promise<T>((resolve, reject) => {
        if (held) {
          signal?.addEventListener('abort', () => reject(new AbortError()), { once: true })
          return
        }

        setImmediate(() => {
          settled++
          resolve(reply())
        })
      })
    }

    return {
      get: key =>
        run('get', key, () => {
          const value = strings.get(key)

          return value === undefined ? null : buffers ? counterAs(value) : value
        }),
      hmGet: (key, fields) =>
        run('hmGet', key, () =>
          fields.map(name => {
            const field = hashes.get(key)?.get(name)

            if (field === undefined || field.expiresAt <= Date.now()) {
              return null
            }

            return buffers ? field.value : field.value.toString()
          }),
        ),
      hSetEx: (key, fields, options) =>
        run('hSetEx', key, () => {
          const hash = hashes.get(key) ?? new Map<string, { value: Buffer; expiresAt: number }>()
          hashes.set(key, hash)
          for (const [name, value] of Object.entries(fields)) {
            hash.set(name, {
              value: Buffer.isBuffer(value) ? value : Buffer.from(value),
              expiresAt: Date.now() + options.expiration.value,
            })
          }

          return 1
        }),
      incr: key =>
        run('incr', key, () => {
          const next = Number(strings.get(key) ?? '0') + 1
          strings.set(key, String(next))

          return next
        }),
    }
  }

  const asBuffers = (mapping: { [RESP_TYPES.BLOB_STRING]?: unknown } | undefined) =>
    mapping?.[RESP_TYPES.BLOB_STRING] === Buffer

  const client: RedisHTTPCacheClient = {
    withTypeMapping: mapping => {
      const buffers = asBuffers(mapping)
      const view: RedisHTTPCacheView = commandsWith(undefined, buffers)
      if (shape === 'client') {
        view.withAbortSignal = signal => commandsWith(signal, buffers)
      }
      return view
    },
    withCommandOptions: options => {
      withCommandOptions(options)
      return commandsWith(options.abortSignal, asBuffers(options.typeMapping))
    },
  }

  return {
    client,
    sent,
    withCommandOptions,
    hold() {
      held = true
    },
    /** Forgets what was sent, and starts the batch count over. */
    reset() {
      sent.length = 0
      settled = 0
    },
  }
}

const httpEntry = { payload: 'v', statusCode: 200, headers: {} }

describeHTTPCacheStoreContract(
  'RedisHTTPCacheStore',
  () => new RedisHTTPCacheStore(fakeHTTPServer().client),
  elapseDate,
)
describeHTTPCacheStoreContract(
  'RedisHTTPCacheStore on a cluster-shaped client',
  () => new RedisHTTPCacheStore(fakeHTTPServer('cluster').client),
  elapseDate,
)

describe('RedisHTTPCacheStore and the commands it sends', () => {
  // The hooks hand over the route's tags, so the entry and its counters go out together: one round trip.
  it('reads a hinted entry and its counters in one batch', async () => {
    const server = fakeHTTPServer()
    const { sent } = server
    const store = new RedisHTTPCacheStore(server.client)
    await store.put('k', httpEntry, { ttl: 60 * Second, tags: ['pets', 'all'] })
    server.reset()

    expect((await store.get('k', { tags: ['pets', 'all'] }))?.payload).toBe('v')

    expect(sent.map(item => [item.command, item.batch])).toEqual([
      ['hmGet', 0],
      ['get', 0],
      ['get', 0],
    ])
  })

  it('reads a tag the hint left out in a second batch, and an untagged entry with HMGET alone', async () => {
    const server = fakeHTTPServer()
    const { sent } = server
    const store = new RedisHTTPCacheStore(server.client)
    await store.put('tagged', httpEntry, { ttl: 60 * Second, tags: ['pets', 'all'] })
    await store.put('plain', httpEntry, { ttl: 60 * Second })
    server.reset()

    expect((await store.get('tagged', { tags: ['pets'] }))?.payload).toBe('v')
    expect(sent.map(item => [item.command, item.batch])).toEqual([
      ['hmGet', 0],
      ['get', 0],
      ['get', 2],
    ])

    server.reset()
    expect((await store.get('plain', { tags: ['pets'] }))?.payload).toBe('v')
    expect(sent.map(item => item.command)).toEqual(['hmGet', 'get'])

    server.reset()
    expect((await store.get('plain'))?.payload).toBe('v')
    expect(sent.map(item => item.command)).toEqual(['hmGet'])
  })

  it('writes after one batch of counter reads, and evicts with one batch of INCRs', async () => {
    const server = fakeHTTPServer()
    const { sent } = server
    const store = new RedisHTTPCacheStore(server.client)

    await store.put('k', httpEntry, { ttl: 60 * Second, tags: ['a', 'b', 'c'] })
    expect(sent.map(item => item.command)).toEqual(['get', 'get', 'get', 'hSetEx'])
    expect(sent.slice(0, 3).map(item => item.batch)).toEqual([0, 0, 0])
    expect(sent[3].batch).toBe(3)

    server.reset()
    await store.evictByTag(['a', 'b', 'c'])
    expect(sent.map(item => [item.command, item.batch])).toEqual([
      ['incr', 0],
      ['incr', 0],
      ['incr', 0],
    ])
  })

  it('sends nothing for an empty eviction, or for a ttl that is not positive', async () => {
    const { client, sent } = fakeHTTPServer()
    const store = new RedisHTTPCacheStore(client)

    await store.evictByTag([])
    await store.put('a', httpEntry, { ttl: 0, tags: ['pets'] })
    await store.put('b', httpEntry, { ttl: Number.NaN })

    expect(sent).toEqual([])
  })

  // A `ttl` is milliseconds and so is `PX`: an hour that became 3.6 seconds, or a second and a half rounded away,
  // shows as an entry gone too soon or kept too long.
  it.each([
    [1 * Hour, 3_600_000],
    [1.5 * Second, 1500],
    [1 * Millisecond, 1],
  ])('keeps an entry put with a ttl of %s for %ims, and no longer', async (ttl, ms) => {
    const store = new RedisHTTPCacheStore(fakeHTTPServer().client)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await store.put('k', httpEntry, { ttl })

      vi.setSystemTime(Date.now() + ms - 1)
      expect((await store.get('k'))?.payload).toBe('v')

      vi.setSystemTime(Date.now() + 1)
      expect(await store.get('k')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts the prefix in front of every key as given, nothing for an empty one, and caffeine:cache: unset', async () => {
    async function keysWith(prefix?: string) {
      const server = fakeHTTPServer()
      const store = new RedisHTTPCacheStore(server.client, prefix === undefined ? {} : { prefix })
      await store.put('k', httpEntry, { ttl: 60 * Second, tags: ['pets'] })
      await store.evictByTag('pets')

      return server.sent.map(item => item.key)
    }

    const bare = await keysWith('')

    expect(await keysWith('app:')).toEqual(bare.map(key => `app:${key}`))
    expect(await keysWith()).toEqual(bare.map(key => `caffeine:cache:${key}`))
  })

  // Redis hashes the first `{...}` of a key: a brace of the caller's would decide the slot.
  it('refuses a brace in the prefix or in a tag', async () => {
    const { client, sent } = fakeHTTPServer()

    expect(() => new RedisHTTPCacheStore(client, { prefix: 'app:{x}:' })).toThrow(ErrRedisCache)

    const store = new RedisHTTPCacheStore(client)
    await expect(store.put('k', httpEntry, { ttl: 60 * Second, tags: ['a}b'] })).rejects.toThrow(
      'Cannot use the tag "a}b" on a Redis cache: it holds a brace',
    )
    await expect(store.evictByTag('{a')).rejects.toThrow(ErrRedisCache)
    await expect(store.get('k', { tags: ['{a'] })).rejects.toThrow(ErrRedisCache)
    expect(sent).toEqual([])
  })

  // The interface is structural: a client whose view hands the counter back as text, or as the number `INCR`
  // produced, must evict just the same.
  it.each([
    ['text', (value: string) => value],
    ['a number', (value: string) => Number(value)],
  ])('compares counters when the client hands them back as %s', async (_name, reply) => {
    const store = new RedisHTTPCacheStore(fakeHTTPServer('client', reply).client)

    await store.evictByTag('pets')
    await store.put('k', httpEntry, { ttl: 60 * Second, tags: ['pets'] })
    expect((await store.get('k', { tags: ['pets'] }))?.payload).toBe('v')

    await store.evictByTag('pets')
    expect(await store.get('k')).toBeUndefined()
  })
})

describe('RedisHTTPCacheStore and a signal', () => {
  // On a single-server client the signal is bound without replacing the client's own command options.
  it('binds the signal to every command of a call, through withAbortSignal on a client', async () => {
    const server = fakeHTTPServer('client')
    const store = new RedisHTTPCacheStore(server.client)
    const signal = new AbortController().signal
    const calls = [
      () => store.put('k', httpEntry, { ttl: 60 * Second, tags: ['a', 'b'], signal }),
      () => store.get('k', { tags: ['a', 'b'], signal }),
      () => store.evictByTag(['a', 'b'], { signal }),
    ]

    for (const call of calls) {
      server.reset()
      await call()
      expect(server.sent.length).toBeGreaterThan(0)
      expect(server.sent.every(item => item.signal === signal)).toBe(true)
    }

    server.reset()
    await store.get('k')
    expect(server.sent.every(item => item.signal === undefined)).toBe(true)
    expect(server.withCommandOptions).not.toHaveBeenCalled()
  })

  it('binds it through withCommandOptions on a cluster client, which has no withAbortSignal', async () => {
    const { client, sent } = fakeHTTPServer('cluster')
    const store = new RedisHTTPCacheStore(client)
    const signal = new AbortController().signal

    await store.put('k', httpEntry, { ttl: 60 * Second, tags: ['a'], signal })
    await store.get('k', { tags: ['a'], signal })

    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every(item => item.signal === signal)).toBe(true)
  })

  it('gives up a command the server never answers once the signal aborts', async () => {
    const server = fakeHTTPServer()
    const store = new RedisHTTPCacheStore(server.client)
    await store.put('k', httpEntry, { ttl: 60 * Second, tags: ['pets'] })
    server.hold()
    const controller = new AbortController()
    const { signal } = controller

    const calls = Promise.allSettled([
      store.get('k', { tags: ['pets'], signal }),
      store.put('k', httpEntry, { ttl: 60 * Second, signal }),
      store.evictByTag('pets', { signal }),
    ])
    // Every command is out by now, and the server answers none of them.
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()

    for (const call of await calls) {
      expect(call.status).toBe('rejected')
      expect((call as PromiseRejectedResult).reason).toBeInstanceOf(AbortError)
    }
  })

  // A node-redis client queues commands while its server is away, and answers none of them until it is back. The
  // signal is what takes a queued command out again. No server is needed to see it: this one is never reached.
  it('takes a queued command out of a real client whose server is unreachable', async () => {
    const client = createClient({ url: 'redis://127.0.0.1:1', socket: { reconnectStrategy: () => 10 } })
    client.on('error', () => {})
    const connecting = client.connect().catch(() => {})
    const store = new RedisHTTPCacheStore(client)

    try {
      const controller = new AbortController()
      let settled = false
      const reading = store.get('k', { tags: ['pets'], signal: controller.signal }).finally(() => {
        settled = true
      })
      // Queued behind a connection that never comes up: nothing answers it, nothing rejects it.
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)

      controller.abort()

      await expect(reading).rejects.toBeInstanceOf(AbortError)
    } finally {
      try {
        client.destroy()
      } catch {
        // Already closed by the failed connection.
      }
      await connecting
    }
  })

  // The commands of a batch are in flight together and reject together. One left without a handler is an
  // unhandled rejection, which ends the process under Node's default: a store outage would take the server
  // down instead of costing it the cache.
  it('rejects a batch read without leaving a rejection unhandled', async () => {
    const down = new Error('connection lost')
    const slower: (() => void)[] = []
    const view: RedisHTTPCacheView = {
      ...fakeHTTPServer().client.withTypeMapping({} as never),
      get: () => new Promise((_resolve, reject) => slower.push(() => reject(down))),
      hmGet: async () => {
        throw down
      },
    }
    const store = new RedisHTTPCacheStore({ withTypeMapping: () => view, withCommandOptions: () => view })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      await expect(store.get('a', { tags: ['pets'] })).rejects.toBe(down)

      // The slower command rejects only after the read has failed; Node reports an unhandled rejection once the
      // microtasks have run.
      expect(slower).toHaveLength(1)
      slower[0]()
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('RedisHTTPCacheClient', () => {
  it('is satisfied by a node-redis client and by a node-redis cluster client', () => {
    expectTypeOf<ReturnType<typeof createClient>>().toExtend<RedisHTTPCacheClient>()
    expectTypeOf<ReturnType<typeof createCluster>>().toExtend<RedisHTTPCacheClient>()
  })
})
