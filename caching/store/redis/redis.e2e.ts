/**
 * `RedisCache` against real servers: Redis and Valkey, each as one server and as a cluster. The cluster rows are
 * what prove the store never names keys from two slots — a one-node cluster still answers CROSSSLOT.
 *
 *   make redis-up && npx vitest run --config test/e2e/vitest.config.ts redis.e2e
 *
 * It lives beside the store, not under `test/e2e`, so it can run the store contract every `Cache` passes; the
 * e2e Vitest project picks up every `*.e2e.ts` in the repository.
 */
import { randomUUID } from 'node:crypto'
import { connect as dial } from 'node:net'

import { CaffeineIoC } from '@caffeinejs/di'
import { Router, createWebApplication } from '@caffeinejs/http'
import { createClient, createCluster } from '@redis/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HTTPCaching, cacheControl, cacheInvalidate } from '../../http/index.js'
import { describeHTTPCacheStoreContract } from '../../http/store.testkit.js'
import { RedisHTTPCacheStore, type RedisHTTPCacheClient } from './index.js'

// Copies of `test/e2e/internal`'s two helpers: this spec is inside the package's check project, which takes no
// file from outside the package.
function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url)

  return new Promise(resolve => {
    const socket = dial({ host: hostname, port: Number(port || 6379), timeout: 2000 })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }

    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

// A server that is down skips its row — except under `CAFFEINE_E2E_STRICT=1`, as CI runs, where it fails it.
function required(service: string, up: boolean): boolean {
  if (!up && process.env.CAFFEINE_E2E_STRICT === '1') {
    throw new Error(`Cannot run e2e: "${service}" is not reachable`)
  }

  return up
}

type Connection = RedisHTTPCacheClient & {
  connect(): Promise<unknown>
  close(): Promise<unknown> | void
}

// Every server the suite runs against. Adding a server is adding a row; the cases below run once per row.
const SERVERS: { name: string; url: string; connect: (url: string) => Connection }[] = [
  { name: 'Redis', url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', connect: url => createClient({ url }) },
  { name: 'Valkey', url: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6380', connect: url => createClient({ url }) },
  {
    name: 'Redis cluster',
    url: process.env.REDIS_CLUSTER_URL ?? 'redis://127.0.0.1:6381',
    connect: url => createCluster({ rootNodes: [{ url }] }),
  },
  {
    name: 'Valkey cluster',
    url: process.env.VALKEY_CLUSTER_URL ?? 'redis://127.0.0.1:6382',
    connect: url => createCluster({ rootNodes: [{ url }] }),
  },
]

// Probed once, up front, so a row whose server is down skips on its own and the others still run.
const targets = await Promise.all(SERVERS.map(async server => ({ ...server, up: await reachable(server.url) })))

const FORBIDDEN = [
  'scan',
  'scanIterator',
  'keys',
  'flushDb',
  'flushAll',
  'mGet',
  'mSet',
  'del',
  'eval',
  'evalSha',
  'multi',
]

/** Hands the store its commands through a recorder, so a test can say what went to the server and what never did. */
function recording(client: RedisHTTPCacheClient) {
  const sent: { command: string; key: unknown }[] = []

  // A view bound to a signal is a view like any other: what it sends is recorded the same way.
  const record = <T extends object>(view: T): T =>
    new Proxy(view as Record<string, (...args: unknown[]) => unknown>, {
      get(target, property: string) {
        const member = target[property]
        if (typeof member !== 'function') {
          return member
        }
        if (property === 'withAbortSignal') {
          return (signal: AbortSignal) => record(member.call(target, signal) as object)
        }

        return (...args: unknown[]) => {
          sent.push({ command: property, key: args[0] })
          return member.apply(target, args)
        }
      },
    }) as unknown as T

  const wrapped: RedisHTTPCacheClient = {
    withTypeMapping: mapping => record(client.withTypeMapping(mapping)),
    withCommandOptions: options => record(client.withCommandOptions(options)),
  }

  return { client: wrapped, sent }
}

const httpEntry = (payload: string | Buffer) => ({ payload, statusCode: 200, headers: {} })

describe.each(targets)('RedisHTTPCacheStore over $name', ({ name, url, up, connect }) => {
  if (!up) {
    it('is skipped, its server being down', () => {
      expect(required(name, up)).toBe(false)
    })
  }

  describe.skipIf(!up)(url, () => {
    let client: Connection
    const sent: { command: string; key: unknown }[] = []

    const newStore = () => {
      const recorded = recording(client)
      const prefix = `caffeine:cache:e2e:${randomUUID()}:`

      return { store: new RedisHTTPCacheStore(recorded.client, { prefix }), sent: recorded.sent, prefix }
    }

    beforeAll(async () => {
      client = connect(url)
      await client.connect()
    })

    afterAll(async () => {
      await client?.close()
    })

    describeHTTPCacheStoreContract(name, () => {
      const created = newStore()
      // Shared with the last case below, which reads back everything the contract made the store send.
      created.sent.push = (...items) => sent.push(...items)
      return created.store
    })

    it('evicts a tag with one INCR, whatever it covers', async () => {
      const { store, sent: commands } = newStore()
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          store.put(`/pets/${i}`, httpEntry(`pet ${i}`), { ttl: 60, tags: ['pets'] }),
        ),
      )
      commands.length = 0

      await store.evictByTag('pets')

      expect(commands.map(item => item.command)).toEqual(['incr'])
      expect(await store.get('/pets/0', { tags: ['pets'] })).toBeUndefined()
      expect(await store.get('/pets/49')).toBeUndefined()
    })

    // Two application instances share the server, not the process: one evicting a tag is a miss on the other.
    it('lets one instance evict what another instance reads', async () => {
      const prefix = `caffeine:cache:e2e:${randomUUID()}:`
      const writer = new RedisHTTPCacheStore(client, { prefix })
      const reader = new RedisHTTPCacheStore(client, { prefix })
      const stranger = new RedisHTTPCacheStore(client, { prefix: `${prefix}other:` })

      await writer.put('k', httpEntry('shared'), { ttl: 60, tags: ['pets'] })
      await stranger.put('k', httpEntry('theirs'), { ttl: 60, tags: ['pets'] })
      expect((await reader.get('k', { tags: ['pets'] }))?.payload).toBe('shared')

      await writer.evictByTag('pets')

      expect(await reader.get('k', { tags: ['pets'] })).toBeUndefined()
      expect((await stranger.get('k', { tags: ['pets'] }))?.payload).toBe('theirs')
    })

    // Keys carry no hash tag and scatter over the slots, an entry's tag counters included: a call's commands must
    // still go through, which they only do when no command names two of them.
    it('reads, writes and evicts entries whose keys fall in different slots', async () => {
      const { store } = newStore()
      const keys = Array.from({ length: 40 }, (_, i) => `/scattered/${i}`)

      await Promise.all(keys.map(key => store.put(key, httpEntry(key), { ttl: 60, tags: ['scattered', key] })))
      expect(
        (await Promise.all(keys.map(key => store.get(key, { tags: ['scattered', key] })))).map(r => r?.payload),
      ).toEqual(keys)

      await store.evictByTag(keys.slice(0, 20))
      expect((await Promise.all(keys.map(key => store.get(key)))).filter(read => read !== undefined)).toHaveLength(20)

      await store.evictByTag('scattered')
      expect((await Promise.all(keys.map(key => store.get(key)))).every(read => read === undefined)).toBe(true)
    })

    it('sends nothing for a call whose signal is already aborted', async () => {
      const { store, sent: commands } = newStore()
      await store.put('k', httpEntry('v'), { ttl: 60, tags: ['pets'] })
      commands.length = 0
      const signal = AbortSignal.abort()

      await expect(store.get('k', { tags: ['pets'], signal })).rejects.toThrow()
      await expect(store.put('k', httpEntry('w'), { ttl: 60, signal })).rejects.toThrow()
      await expect(store.evictByTag('pets', { signal })).rejects.toThrow()

      expect(commands).toEqual([])
      expect((await store.get('k', { tags: ['pets'] }))?.payload).toBe('v')
    })

    it('backs the HTTP cache: a miss, a hit with the same response, a miss again once the tag is evicted', async () => {
      const { store } = newStore()
      let calls = 0

      const pets = new Router('/pets')
      pets
        .get('/')
        .with(cacheControl({ ttl: 60, tags: ['pets'] }))
        .handler(() => ({ calls: ++calls }))
      pets
        .post('/')
        .with(cacheInvalidate({ tags: ['pets'] }))
        .handler(() => ({ created: true }))

      const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .with(HTTPCaching(b => b.store(store)))
        .mount(pets)
      await app.ready()

      try {
        const miss = await app.fetch('/pets')
        const hit = await app.fetch('/pets')
        expect(miss.headers.get('x-cache')).toBe('MISS')
        expect(hit.headers.get('x-cache')).toBe('HIT')
        expect(await hit.json()).toEqual({ calls: 1 })
        expect(hit.headers.get('content-type')).toBe(miss.headers.get('content-type'))

        await app.fetch('/pets', { method: 'POST' })

        const after = await app.fetch('/pets')
        expect(after.headers.get('x-cache')).toBe('MISS')
        expect(await after.json()).toEqual({ calls: 2 })
      } finally {
        await app.close()
      }
    })

    // Last on purpose: it reads back what every case of the contract made the store send.
    it('never walked the keyspace, flushed, ran a script, or named two keys in one command', () => {
      expect(sent.length).toBeGreaterThan(0)
      expect(sent.filter(item => FORBIDDEN.includes(item.command))).toEqual([])
      // Each of these was handed one key, never a list of them, so nothing the store sent could cross a slot.
      expect(new Set(sent.map(item => item.command))).toEqual(new Set(['get', 'hmGet', 'hSetEx', 'incr']))
      expect(sent.filter(item => typeof item.key !== 'string')).toEqual([])
    })
  })
})
