/**
 * The HTTP cache through a Redis or Valkey outage: replies that stop coming, connections that drop, and the way
 * back. Every request is asserted to go on without the cache, and the cache to work again once the server does.
 *
 *   make redis-up && npx vitest run --config test/e2e/vitest.config.ts caching.chaos
 *
 * The outage is staged by a TCP relay the client dials instead of the server, so no container is touched. The
 * one-node clusters are not rows: a cluster client dials the addresses the nodes announce, past any relay.
 */
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  ErrCacheStoreTimeout,
  HTTPCaching,
  cacheControl,
  cacheInvalidate,
  type CacheErrorEvent,
  type CacheHitEvent,
  type CacheInvalidateEvent,
  type CacheStoreEvent,
} from '@caffeinejs/caching/http'
import { RedisHTTPCacheStore } from '@caffeinejs/caching/store/redis'
import { Router } from '@caffeinejs/http'
import { createClient } from '@redis/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { reachable } from './internal/redis/index.js'
import { required } from './internal/strict.js'
import { startProxy, type TCPProxy } from './internal/tcp_proxy.js'

// The standalone servers. Adding a server is adding a row; the cases below run once per row, in order.
const SERVERS = [
  { name: 'Redis', url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' },
  { name: 'Valkey', url: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6380' },
]

const targets = await Promise.all(SERVERS.map(async server => ({ ...server, up: await reachable(server.url) })))

class Recording {
  readonly errors: CacheErrorEvent[] = []
  readonly hits: CacheHitEvent[] = []
  readonly stores: CacheStoreEvent[] = []
  readonly invalidations: CacheInvalidateEvent[] = []
  readonly observer = {
    onError: (event: CacheErrorEvent) => this.errors.push(event),
    onHit: (event: CacheHitEvent) => this.hits.push(event),
    onStore: (event: CacheStoreEvent) => this.stores.push(event),
    onInvalidate: (event: CacheInvalidateEvent) => this.invalidations.push(event),
  }
  reset() {
    this.errors.length = 0
    this.hits.length = 0
    this.stores.length = 0
    this.invalidations.length = 0
  }
}

function ignore(): void {
  return undefined
}

function newClient(port: number, options: { disableOfflineQueue?: boolean } = {}) {
  const client = createClient({
    url: `redis://127.0.0.1:${port}`,
    socket: { reconnectStrategy: () => 50 },
    disableOfflineQueue: options.disableOfflineQueue,
  })
  // A dropped connection is what these cases are about; the client says so on its error channel, and an
  // unlistened error event would throw.
  client.on('error', ignore)
  return client
}

function routes(calls: { n: number }) {
  const pets = new Router('/pets')
  pets
    .get('/')
    .with(cacheControl({ ttl: 60, tags: ['pets'], staleWhileRevalidate: 30 }))
    .handler(() => ({ calls: ++calls.n }))
  pets
    .put('/:id')
    .with(cacheInvalidate({ tags: ['pets'] }))
    .handler(() => ({ ok: true }))

  const plain = new Router('/plain')
  plain.get('/').handler(() => ({ ok: true }))

  return { pets, plain }
}

describe.each(targets)('the HTTP cache under a $name outage', ({ name, url, up }) => {
  if (!up) {
    it('is skipped, its server being down', () => {
      expect(required(name, up)).toBe(false)
    })
  }

  describe.skipIf(!up)(url, () => {
    const { hostname, port } = new URL(url)
    const prefix = `caffeine:cache:chaos:${randomUUID()}:`
    let proxy: TCPProxy
    let client: ReturnType<typeof newClient>
    let running: RunningApp
    const recording = new Recording()
    const calls = { n: 0 }

    const get = (path: string) => fetch(`${running.origin}${path}`)
    const status = async (path: string) => (await get(path)).headers.get('x-cache')

    beforeAll(async () => {
      proxy = await startProxy({ host: hostname, port: Number(port || 6379) })
      client = newClient(proxy.port)
      await client.connect()

      const store = new RedisHTTPCacheStore(client, { prefix })
      const { pets, plain } = routes(calls)
      running = await startApp(app =>
        app
          .with(HTTPCaching(b => b.store(store).storeTimeout('200ms').observer(recording.observer)))
          .mount(pets)
          .mount(plain),
      )
    })

    afterAll(async () => {
      proxy?.accept()
      await running?.close()
      client?.destroy()
      await proxy?.close()
    })

    it('warm: a miss, a hit, an eviction, a miss', async () => {
      expect(await status('/pets')).toBe('MISS')
      expect(await status('/pets')).toBe('HIT')
      expect((await fetch(`${running.origin}/pets/1`, { method: 'PUT' })).status).toBe(200)
      expect(await status('/pets')).toBe('MISS')
      expect(recording.errors).toEqual([])
      expect(recording.invalidations).toHaveLength(1)
    })

    it('replies stop coming: every request is answered by the handler within storeTimeout, and the store failure is reported', async () => {
      recording.reset()
      const before = calls.n
      proxy.hold()

      const started = Date.now()
      const res = await get('/pets')
      const elapsed = Date.now() - started

      expect(res.status).toBe(200)
      expect(res.headers.get('x-cache')).toBe('MISS')
      expect(await res.json()).toEqual({ calls: before + 1 })
      expect(elapsed).toBeGreaterThanOrEqual(190)
      expect(elapsed).toBeLessThan(1500)
      expect(recording.errors.map(event => event.operation)).toEqual(['get', 'put'])
      for (const event of recording.errors) {
        expect(event.error).toBeInstanceOf(ErrCacheStoreTimeout)
      }

      // The leader's write timed out, so the requests behind it run the handler themselves.
      const pair = await Promise.all([get('/pets'), get('/pets')])
      expect(pair.map(r => r.headers.get('x-cache'))).toEqual(['MISS', 'MISS'])
      expect(calls.n).toBe(before + 3)

      // An eviction times out the same way, and the mutation still went through.
      const mutated = await fetch(`${running.origin}/pets/1`, { method: 'PUT' })
      expect(mutated.status).toBe(200)
      expect(recording.errors.at(-1)?.operation).toBe('evict')
      expect(recording.invalidations).toEqual([])

      // Nothing was served stale: the store could not be read.
      expect(recording.hits).toEqual([])
    })

    it('the uncached route is untouched by any of it', async () => {
      const started = Date.now()
      const res = await get('/plain')

      expect(res.status).toBe(200)
      expect(Date.now() - started).toBeLessThan(150)
    })

    it('replies come back: the late ones are dropped, and the cache fills and serves again', async () => {
      proxy.release()
      recording.reset()
      await sleep(50)

      // Whatever the held-back writes left behind, an eviction and a fresh miss put the cache back in step.
      expect((await fetch(`${running.origin}/pets/1`, { method: 'PUT' })).status).toBe(200)
      expect(await status('/pets')).toBe('MISS')
      expect(await status('/pets')).toBe('HIT')
      expect(recording.errors).toEqual([])
      expect(recording.stores).toHaveLength(1)
    })

    it('the server goes away: every store call fails and is reported; back, the client reconnects and the cache works again with no restart', async () => {
      recording.reset()
      proxy.dropConnections()
      proxy.refuse()

      try {
        // Long enough for the client to see its connection go. A reconnect that is refused rejects the commands
        // queued behind it with the socket's error, so they fail fast; only a server that accepts and never
        // answers leaves them to storeTimeout.
        await sleep(50)

        const started = Date.now()
        const during = await get('/pets')
        expect(during.status).toBe(200)
        expect(during.headers.get('x-cache')).toBe('MISS')
        expect(Date.now() - started).toBeLessThan(1000)
        expect(recording.errors.map(event => event.operation)).toEqual(['get', 'put'])
        for (const event of recording.errors) {
          expect(event.error).toBeInstanceOf(Error)
        }
      } finally {
        proxy.accept()
      }

      recording.reset()
      await sleep(300)
      expect((await fetch(`${running.origin}/pets/1`, { method: 'PUT' })).status).toBe(200)
      expect(await status('/pets')).toBe('MISS')
      expect(await status('/pets')).toBe('HIT')
      expect(recording.errors).toEqual([])
    })

    it('a client that queues nothing offline rejects at once, which the cache reports and goes on from', async () => {
      proxy.accept()
      const offline = newClient(proxy.port, { disableOfflineQueue: true })
      await offline.connect()
      const store = new RedisHTTPCacheStore(offline, { prefix: `${prefix}offline:` })
      const seen = new Recording()
      const own = { n: 0 }
      const { pets, plain } = routes(own)
      const app = await startApp(app =>
        app
          .with(HTTPCaching(b => b.store(store).observer(seen.observer)))
          .mount(pets)
          .mount(plain),
      )

      try {
        expect((await fetch(`${app.origin}/pets`)).headers.get('x-cache')).toBe('MISS')
        proxy.dropConnections()
        proxy.refuse()
        await sleep(20)

        const started = Date.now()
        const res = await fetch(`${app.origin}/pets`)
        expect(res.status).toBe(200)
        expect(res.headers.get('x-cache')).toBe('MISS')
        expect(Date.now() - started).toBeLessThan(150)
        expect(seen.errors.map(event => event.operation)).toEqual(['get', 'put'])
        expect(seen.errors[0].error).not.toBeInstanceOf(ErrCacheStoreTimeout)
      } finally {
        proxy.accept()
        await app.close()
        offline.destroy()
      }
    })

    it('a client that leaves mid-read takes the read out with it, and nothing is reported', async () => {
      proxy.accept()
      const leaving = newClient(proxy.port)
      await leaving.connect()
      const store = new RedisHTTPCacheStore(leaving, { prefix: `${prefix}leaving:` })
      const seen = new Recording()
      const own = { n: 0 }
      const { pets, plain } = routes(own)
      const app = await startApp(app =>
        app
          .with(HTTPCaching(b => b.store(store).observer(seen.observer)))
          .mount(pets)
          .mount(plain),
      )

      try {
        proxy.hold()
        const socket = connect({ host: '127.0.0.1', port: Number(new URL(app.origin).port) })
        await new Promise(resolve => socket.once('connect', resolve))
        socket.write('GET /pets HTTP/1.1\r\nHost: localhost\r\n\r\n')
        await sleep(100)
        socket.destroy()
        await sleep(100)
        proxy.release()
        await sleep(100)

        expect(seen.errors).toEqual([])
      } finally {
        await app.close()
        leaving.destroy()
      }
    })
  })
})
