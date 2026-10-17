import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import { Controller, Get, Head, Header } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import type { FlightTable } from '../flight.js'
import {
  CacheControl,
  HTTPCaching,
  cachePlugin,
  type CacheHitEvent,
  type CacheMissEvent,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCachePutOptions,
  type HTTPCacheStore,
} from '../index.js'
import { WatchedStore, counter, gate, turn } from './_latch.js'

class Recording {
  readonly hits: CacheHitEvent[] = []
  readonly misses: CacheMissEvent[] = []
  readonly observer = {
    onHit: (event: CacheHitEvent) => this.hits.push(event),
    onMiss: (event: CacheMissEvent) => this.misses.push(event),
  }
  get coalesced() {
    return this.hits.filter(hit => hit.coalesced).length
  }
  reasons() {
    return this.misses.map(miss => miss.reason)
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) {
      return
    }
    await sleep(5)
  }
  throw new Error('Condition not met in time')
}

describe('concurrent misses for one key', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('run the handler once: the first leads, the rest are served what it stored', async () => {
    let calls = 0
    const g = gate()

    @Controller('/sf-once')
    class OnceController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { n: calls }
      }
    }
    void [OnceController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-once/data')
    await g.seen
    const followers = Array.from({ length: 4 }, () => app.fetch('/sf-once/data'))
    await sleep(10)
    g.open()

    const responses = await Promise.all([leader, ...followers])

    expect(calls).toBe(1)
    expect(responses.map(res => res.headers.get('x-cache'))).toEqual(['MISS', 'HIT', 'HIT', 'HIT', 'HIT'])
    for (const res of responses) {
      expect(await res.json()).toEqual({ n: 1 })
    }
    expect(recording.coalesced).toBe(4)
    expect(recording.reasons()).toEqual(['absent'])
  })

  it('run the handler themselves when the leader stored nothing: a cookie, an error, a rejected write', async () => {
    let cookies = 0
    let throws = 0
    let failed = 0
    const gates = { cookie: gate(), throws: gate(), failed: gate() }

    class FailingWrites implements HTTPCacheStore {
      readonly inner = new MemoryHTTPCacheStore()
      get(key: string, options?: HTTPCacheGetOptions) {
        return this.inner.get(key, options)
      }
      async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions) {
        if (key.includes('failed')) {
          throw new Error('store down')
        }
        return this.inner.put(key, entry, options)
      }
      evictByTag() {
        return this.inner.evictByTag([])
      }
    }

    @Controller('/sf-nothing')
    @CacheControl({ ttl: 60 })
    class NothingController {
      @Header('Set-Cookie', 'session=1')
      @Get('/cookie')
      async cookie() {
        cookies++
        await gates.cookie.hold()
        return { ok: true }
      }

      @Get('/throws')
      async throws() {
        throws++
        await gates.throws.hold()
        throw new Error('boom')
      }

      @Get('/failed')
      async failed() {
        failed++
        await gates.failed.hold()
        return { ok: true }
      }
    }
    void [NothingController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new FailingWrites()).observer(recording.observer).storeTimeout('1s')),
    )
    close = () => app.close()
    await app.bootstrap()

    for (const [path, g] of Object.entries(gates)) {
      const leader = app.fetch(`/sf-nothing/${path}`)
      await g.seen
      const follower = app.fetch(`/sf-nothing/${path}`)
      await sleep(10)
      g.open()
      const [led, followed] = await Promise.all([leader, follower])
      expect(led.headers.get('x-cache')).toBe('MISS')
      expect(followed.headers.get('x-cache')).toBe('MISS')
    }

    expect([cookies, throws, failed]).toEqual([2, 2, 2])
    expect(recording.coalesced).toBe(0)
    expect(recording.reasons().filter(reason => reason === 'not-coalesced')).toHaveLength(3)
  })

  it('run the handler themselves when the leader put never answers, once storeTimeout passes', async () => {
    let calls = 0
    const g = gate()

    class HungWrites implements HTTPCacheStore {
      readonly inner = new MemoryHTTPCacheStore()
      get(key: string, options?: HTTPCacheGetOptions) {
        return this.inner.get(key, options)
      }
      put(): Promise<void> {
        return new Promise(() => {})
      }
      evictByTag() {
        return this.inner.evictByTag([])
      }
    }

    @Controller('/sf-hung')
    class HungController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { ok: true }
      }
    }
    void [HungController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new HungWrites()).observer(recording.observer).storeTimeout('30ms')),
    )
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-hung/data')
    await g.seen
    const follower = app.fetch('/sf-hung/data')
    await sleep(10)
    g.open()
    await Promise.all([leader, follower])

    expect(calls).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])
  })

  it('answer only-if-cached with 504 at once, without waiting on the flight', async () => {
    const g = gate()

    @Controller('/sf-oic')
    class OICController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        await g.hold()
        return { ok: true }
      }
    }
    void [OICController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-oic/data')
    await g.seen
    const impatient = await app.fetch('/sf-oic/data', { headers: { 'cache-control': 'only-if-cached' } })
    expect(impatient.status).toBe(504)

    g.open()
    await leader
  })

  it('each run the handler on a route with lock: false, or without a ttl', async () => {
    let unlocked = 0
    let unstored = 0
    const gates = { unlocked: gate(), unstored: gate() }

    @Controller('/sf-off')
    class OffController {
      @CacheControl({ ttl: 60, lock: false })
      @Get('/unlocked')
      async a() {
        unlocked++
        await gates.unlocked.hold()
        return { ok: true }
      }

      @CacheControl({ noCache: true })
      @Get('/unstored')
      async b() {
        unstored++
        await gates.unstored.hold()
        return { ok: true }
      }
    }
    void [OffController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.bootstrap()

    for (const [path, g] of Object.entries(gates)) {
      const leader = app.fetch(`/sf-off/${path}`)
      await g.seen
      const follower = app.fetch(`/sf-off/${path}`)
      await sleep(10)
      g.open()
      await Promise.all([leader, follower])
    }

    expect([unlocked, unstored]).toEqual([2, 2])
    expect(recording.reasons().filter(reason => reason === 'not-coalesced')).toEqual([])
  })

  it('each run the handler when the store could not be read: nothing a follower could wait for', async () => {
    let calls = 0
    const g = gate()

    class Down implements HTTPCacheStore {
      async get(): Promise<undefined> {
        throw new Error('store down')
      }
      async put() {}
      async evictByTag() {}
    }

    @Controller('/sf-down')
    class DownController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { ok: true }
      }
    }
    void [DownController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new Down())))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-down/data')
    await g.seen
    const follower = app.fetch('/sf-down/data')
    await sleep(10)
    g.open()
    await Promise.all([leader, follower])

    expect(calls).toBe(2)
  })

  it('run the handler again when what the leader stored is gone by the time a follower reads', async () => {
    let calls = 0
    const g = gate()

    class Forgetful implements HTTPCacheStore {
      async get(): Promise<undefined> {
        return undefined
      }
      async put() {}
      async evictByTag() {}
    }

    @Controller('/sf-gone')
    class GoneController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { ok: true }
      }
    }
    void [GoneController]

    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(new Forgetful()).observer(recording.observer)))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-gone/data')
    await g.seen
    const follower = app.fetch('/sf-gone/data')
    await sleep(10)
    g.open()
    await Promise.all([leader, follower])

    expect(calls).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])
  })

  // What the leader stored is fresh, but not fresh enough for a follower that asked for more freshness than the
  // route's ttl can give: it runs the handler itself rather than take what it said it would not.
  it('run the handler again for a follower that cannot accept what the leader stored', async () => {
    let calls = 0
    const g = gate()

    @Controller('/sf-fresh')
    class FreshController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        if (calls === 1) {
          await g.hold()
        }
        return { n: calls }
      }
    }
    void [FreshController]

    const store = new WatchedStore()
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store).observer(recording.observer)))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-fresh/data')
    await g.seen
    const follower = app.fetch('/sf-fresh/data', { headers: { 'cache-control': 'min-fresh=120' } })
    await store.reads.reached(2)
    await turn()
    g.open()
    const [led, followed] = await Promise.all([leader, follower])

    expect(led.headers.get('x-cache')).toBe('MISS')
    expect(followed.headers.get('x-cache')).toBe('MISS')
    expect(await followed.json()).toEqual({ n: 2 })
    expect(calls).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])
    expect(recording.coalesced).toBe(0)
  })

  it('run the handler again when a follower cannot re-read the store, and report the failure', async () => {
    let calls = 0
    let reads = 0
    const g = gate()

    // The leader's read and the follower's first read find nothing; the follower's re-read, after the leader
    // stored, is the one that fails.
    class FailsOnReread implements HTTPCacheStore {
      readonly inner = new MemoryHTTPCacheStore()
      async get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
        if (++reads === 3) {
          throw new Error('store went away')
        }
        return this.inner.get(key, options)
      }
      put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions) {
        return this.inner.put(key, entry, options)
      }
      async evictByTag() {}
    }

    @Controller('/sf-reread')
    class RereadController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        if (calls === 1) {
          await g.hold()
        }
        return { n: calls }
      }
    }
    void [RereadController]

    const recording = new Recording()
    const errors: { operation: string; error: unknown }[] = []
    const app = createWebApplication().with(
      HTTPCaching(b =>
        b.store(new FailsOnReread()).observer({ ...recording.observer, onError: event => errors.push(event) }),
      ),
    )
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-reread/data')
    await g.seen
    const follower = app.fetch('/sf-reread/data')
    await sleep(10)
    g.open()
    const [led, followed] = await Promise.all([leader, follower])

    expect(led.status).toBe(200)
    expect(followed.status).toBe(200)
    expect(followed.headers.get('x-cache')).toBe('MISS')
    expect(await followed.json()).toEqual({ n: 2 })
    expect(calls).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])
    expect(errors).toMatchObject([{ operation: 'get', error: { message: 'store went away' } }])
  })
})

describe('a HEAD and the flight', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // A HEAD's response is never stored: leading would only release its followers to nothing.
  it('never leads: a GET behind a HEAD runs the handler itself', async () => {
    let calls = 0
    const g = gate()

    @Controller('/sf-head-leads')
    class HeadLeadsController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { value: 'x'.repeat(50) }
      }
    }
    void [HeadLeadsController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.bootstrap()

    const head = app.fetch('/sf-head-leads/data', { method: 'HEAD' })
    await g.seen
    const get = app.fetch('/sf-head-leads/data')
    await sleep(10)
    g.open()
    await Promise.all([head, get])

    expect(calls).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'absent'])
  })

  it('does follow a GET, and is answered with the GET length and no body', async () => {
    const g = gate()

    @Controller('/sf-head-follows')
    class HeadFollowsController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      async data() {
        await g.hold()
        return { value: 'x'.repeat(50) }
      }
    }
    void [HeadFollowsController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.bootstrap()

    const leader = app.fetch('/sf-head-follows/data')
    await g.seen
    const head = app.fetch('/sf-head-follows/data', { method: 'HEAD' })
    await sleep(10)
    g.open()
    const [get, headRes] = await Promise.all([leader, head])

    expect(headRes.headers.get('x-cache')).toBe('HIT')
    expect(headRes.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(await headRes.text()).toBe('')
    expect(recording.coalesced).toBe(1)
  })

  it('leaves a route with its own HEAD handler to the HEAD handler', async () => {
    let heads = 0

    @CacheControl({ ttl: 60 })
    @Controller('/sf-own-head')
    class OwnHeadController {
      @Head('/data')
      head() {
        heads++
        return ''
      }

      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [OwnHeadController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.bootstrap()

    await app.fetch('/sf-own-head/data', { method: 'HEAD' })
    await app.fetch('/sf-own-head/data', { method: 'HEAD' })

    expect(heads).toBe(2)
  })
})

/**
 * On a raw Fastify server, with the flight table in hand: what happens to a flight whose store hook never runs,
 * and to one that outlives its own timeout.
 */
describe('the flight table', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start(options: { lockTimeoutMs: number; hijack?: boolean; handler?: () => Promise<unknown> }) {
    const flights: FlightTable = new Map()
    const store = new MemoryHTTPCacheStore()
    const recording = new Recording()
    const server = fastify()
    close = () => server.close()
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: recording.observer,
        flights,
        lockTimeoutMs: options.lockTimeoutMs,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 } },
      handler: options.hijack
        ? (_request, reply) => {
            reply.hijack()
            reply.raw.end('raw')
          }
        : (options.handler ?? (() => ({ ok: true }))),
    })
    await server.ready()

    return { server, flights, store, recording }
  }

  it('is not consulted on a fresh hit', async () => {
    const { server, flights } = await start({ lockTimeoutMs: 1000 })
    let reads = 0
    const get = flights.get.bind(flights)
    flights.get = key => {
      reads++
      return get(key)
    }

    // A miss looks the key up, then the flight checks its own identity as it settles; a hit does none of it.
    await server.inject('/data')
    const afterMiss = reads
    expect(afterMiss).toBeGreaterThan(0)

    await server.inject('/data')
    expect(reads).toBe(afterMiss)
  })

  // Hooks do not run after a hijack, so nothing settles the flight but its own timer.
  it('releases the followers of a leader that hijacked its reply at lockTimeout, and forgets the flight', async () => {
    const { server, flights, recording } = await start({ lockTimeoutMs: 50, hijack: true })

    const leader = server.inject('/data')
    await waitFor(() => flights.size === 1)
    const started = Date.now()
    const follower = server.inject('/data')

    await Promise.all([leader, follower])

    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(flights.size).toBe(0)
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])
  })

  it('lets a leader that outlived its timeout settle only its own flight, and its late write still lands', async () => {
    const gates = [gate(), gate()]
    let arrivals = 0
    const { server, flights, store, recording } = await start({
      lockTimeoutMs: 30,
      handler: async () => {
        const mine = arrivals++
        await gates[mine].hold()
        return { arrival: mine }
      },
    })

    const slow = server.inject('/data')
    await gates[0].seen
    const first = flights.get(encodeURIComponent('/data'))
    expect(first).toBeDefined()

    // The timer fires: the flight is forgotten, and the next miss leads a new one under the same key.
    await waitFor(() => flights.size === 0)
    const next = server.inject('/data')
    await gates[1].seen
    const second = flights.get(encodeURIComponent('/data'))
    expect(second).toBeDefined()
    expect(second).not.toBe(first)

    gates[0].open()
    await slow
    // The slow leader settled its own flight, which was already gone; the newer one is untouched.
    expect(flights.get(encodeURIComponent('/data'))).toBe(second)
    expect((await store.get(encodeURIComponent('/data')))?.payload).toBe('{"arrival":0}')

    gates[1].open()
    await next
    expect(flights.size).toBe(0)
    expect(recording.reasons()).toEqual(['absent', 'absent'])
  })

  it('still stores and releases the followers of a leader whose client went away', async () => {
    const g = gate()
    const { server, recording } = await start({
      lockTimeoutMs: 1000,
      handler: async () => {
        await g.hold()
        return { ok: true }
      },
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const { port } = server.server.address() as { port: number }

    const socket = connect({ host: '127.0.0.1', port })
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write('GET /data HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await g.seen
    const follower = server.inject('/data')
    await sleep(10)

    socket.destroy()
    await sleep(10)
    g.open()

    const res = await follower
    expect(res.headers['x-cache']).toBe('HIT')
    expect(recording.coalesced).toBe(1)
  })
})

describe('a follower whose request is over', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  /** Counts the reads, so a follower's re-read of the store shows. */
  class CountingStore implements HTTPCacheStore {
    readonly inner = new MemoryHTTPCacheStore()
    gets = 0
    get(key: string, options?: HTTPCacheGetOptions) {
      this.gets++
      return this.inner.get(key, options)
    }
    put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions) {
      return this.inner.put(key, entry, options)
    }
    evictByTag(tags: string | readonly string[]) {
      return this.inner.evictByTag(tags)
    }
  }

  async function start(options: {
    lockTimeoutMs: number
    handlerTimeout?: number
    hijack?: boolean
    handler?: () => Promise<unknown>
  }) {
    const store = new CountingStore()
    const recording = new Recording()
    const server = fastify(options.handlerTimeout === undefined ? {} : { handlerTimeout: options.handlerTimeout })
    close = () => server.close()
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: recording.observer,
        flights: new Map() as FlightTable,
        lockTimeoutMs: options.lockTimeoutMs,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 } },
      handler: options.hijack
        ? (_request, reply) => {
            reply.hijack()
            reply.raw.end('raw')
          }
        : (options.handler ?? (() => ({ ok: true }))),
    })
    await server.ready()

    return { server, store, recording }
  }

  // A follower whose client left has nobody to serve. Waiting on would hold its hook, and a re-read, for as long
  // as the leader takes; instead it goes on at once, and Fastify treats it as any request whose client left.
  it('stops waiting when its client leaves: no re-read, nothing reported', async () => {
    let calls = 0
    const g = gate()
    const { server, store, recording } = await start({
      lockTimeoutMs: 1000,
      handler: async () => {
        calls++
        await g.hold()
        return { ok: true }
      },
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const { port } = server.server.address() as { port: number }

    const leader = server.inject('/data')
    await g.seen

    const socket = connect({ host: '127.0.0.1', port })
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write('GET /data HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await waitFor(() => store.gets === 2)
    await sleep(10)
    expect(calls).toBe(1)

    // The follower gives up its wait and, with the gate still closed, enters the handler itself.
    socket.destroy()
    await waitFor(() => calls === 2)
    expect(store.gets).toBe(2)

    g.open()
    const led = await leader
    expect(led.headers['x-cache']).toBe('MISS')
    expect(recording.reasons()).toEqual(['absent'])
    expect(recording.hits).toEqual([])
  })

  // The flight settled and the follower went back to the store, then its own request ended while it was still
  // reading. Nobody is left to serve or to tell: no hit, no miss, no store failure.
  it('goes quietly when its request ends while it re-reads the store', async () => {
    let calls = 0
    const g = gate()
    const reads = counter()
    const inner = new MemoryHTTPCacheStore()
    const store: HTTPCacheStore = {
      get(key, options) {
        reads.tick()
        if (reads.count < 3) {
          return inner.get(key, options)
        }
        // The follower's re-read: answered by nothing but the end of its request.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      },
      put: (key, entry, options) => inner.put(key, entry, options),
      evictByTag: tags => inner.evictByTag(tags),
    }
    const recording = new Recording()
    const errors: unknown[] = []
    const server = fastify({ handlerTimeout: 1000 })
    close = () => server.close()
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: { ...recording.observer, onError: event => errors.push(event) },
        flights: new Map(),
        lockTimeoutMs: 60_000,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 } },
      handler: async () => {
        calls++
        await g.hold()
        return { ok: true }
      },
    })
    await server.ready()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const leader = server.inject('/data')
    await g.seen
    const follower = server.inject('/data')
    await reads.reached(2)
    await turn()
    g.open()
    await reads.reached(3)
    await vi.advanceTimersByTimeAsync(1000)
    const [led, followed] = await Promise.all([leader, follower])

    expect(led.headers['x-cache']).toBe('MISS')
    expect(followed.statusCode).toBe(503)
    expect(calls).toBe(1)
    expect(errors).toEqual([])
    expect(recording.reasons()).toEqual(['absent'])
    expect(recording.hits).toEqual([])
  })

  // Fastify answers the follower 503 at its handler timeout. The follower's wait ends there: when the flight
  // settles later it is not there to re-read the store, nor to report a miss on a reply already sent.
  it('stops waiting at the handler timeout, and is not heard from when the flight settles', async () => {
    const { server, store, recording } = await start({ lockTimeoutMs: 200, handlerTimeout: 40, hijack: true })

    // The leader hijacks, which clears its own timeout and settles its flight only at lockTimeout.
    const leader = await server.inject('/data')
    expect(leader.body).toBe('raw')

    const follower = await server.inject('/data')
    expect(follower.statusCode).toBe(503)
    expect(store.gets).toBe(2)

    await sleep(300)
    expect(store.gets).toBe(2)
    expect(recording.reasons()).toEqual(['absent'])
  })
})

describe('lockTimeout', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it.each([0, 'never'])('is refused when it is not a positive duration: %s', async value => {
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).lockTimeout(value as number)),
    )
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(/lockTimeout must be a positive duration/)
  })
})
