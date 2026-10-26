import { connect } from 'node:net'

import { Controller, Get, Head, Header } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
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
import { WatchedStore, counter, gate, turn, whenAborted } from './_latch.js'

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

describe('concurrent misses for one key', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  it('run the handler once: the first leads, the rest are served what it stored', async () => {
    let calls = 0
    const g = gate()

    @Controller('/sf-once')
    class OnceController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { n: calls }
      }
    }
    void [OnceController]

    const store = new WatchedStore()
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store).observer(recording.observer)))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.request('/sf-once/data')
    await g.seen
    const followers = Array.from({ length: 4 }, () => app.request('/sf-once/data'))
    await store.reads.reached(5)
    await turn()
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
    @CacheControl({ ttl: 60 * Second })
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

    const store = new WatchedStore(new FailingWrites())
    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b =>
        b
          .store(store)
          .observer(recording.observer)
          .storeTimeout(1 * Second),
      ),
    )
    close = () => app.close()
    await app.bootstrap()

    for (const [path, g] of Object.entries(gates)) {
      const reads = store.reads.count
      const leader = app.request(`/sf-nothing/${path}`)
      await g.seen
      const follower = app.request(`/sf-nothing/${path}`)
      await store.reads.reached(reads + 2)
      await turn()
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
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { ok: true }
      }
    }
    void [HungController]

    const store = new WatchedStore(new HungWrites())
    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b =>
        b
          .store(store)
          .observer(recording.observer)
          .storeTimeout(30 * Millisecond),
      ),
    )
    close = () => app.close()
    await app.bootstrap()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const leader = app.request('/sf-hung/data')
    await g.seen
    const follower = app.request('/sf-hung/data')
    await store.reads.reached(2)
    await turn()
    g.open()
    await store.writes.reached(1)

    await vi.advanceTimersByTimeAsync(29)
    expect(calls).toBe(1)

    // The follower runs the handler once the leader gives up on its put, and gives up on its own put in turn.
    await vi.advanceTimersByTimeAsync(1)
    await store.writes.reached(2)
    await vi.advanceTimersByTimeAsync(30)
    await Promise.all([leader, follower])

    expect(calls).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])
  })

  it('answer only-if-cached with 504 at once, without waiting on the flight', async () => {
    const g = gate()

    @Controller('/sf-oic')
    class OICController {
      @CacheControl({ ttl: 60 * Second })
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

    const leader = app.request('/sf-oic/data')
    await g.seen
    const impatient = await app.request('/sf-oic/data', { headers: { 'cache-control': 'only-if-cached' } })
    expect(impatient.status).toBe(504)

    g.open()
    await leader
  })

  it('each run the handler on a route with lock: false, or without a ttl', async () => {
    const runs = { unlocked: counter(), unstored: counter() }
    const gates = { unlocked: gate(), unstored: gate() }

    @Controller('/sf-off')
    class OffController {
      @CacheControl({ ttl: 60 * Second, lock: false })
      @Get('/unlocked')
      async a() {
        runs.unlocked.tick()
        await gates.unlocked.hold()
        return { ok: true }
      }

      @CacheControl({ noCache: true })
      @Get('/unstored')
      async b() {
        runs.unstored.tick()
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

    for (const path of ['unlocked', 'unstored'] as const) {
      const leader = app.request(`/sf-off/${path}`)
      await gates[path].seen
      const follower = app.request(`/sf-off/${path}`)
      // The second request is in the handler while the first is still held there.
      await runs[path].reached(2)
      gates[path].open()
      await Promise.all([leader, follower])
    }

    expect([runs.unlocked.count, runs.unstored.count]).toEqual([2, 2])
    expect(recording.reasons().filter(reason => reason === 'not-coalesced')).toEqual([])
  })

  it('each run the handler when the store could not be read: nothing a follower could wait for', async () => {
    const runs = counter()
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
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      async data() {
        runs.tick()
        await g.hold()
        return { ok: true }
      }
    }
    void [DownController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new Down())))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.request('/sf-down/data')
    await g.seen
    const follower = app.request('/sf-down/data')
    // The second request is in the handler while the first is still held there.
    await runs.reached(2)
    g.open()
    await Promise.all([leader, follower])

    expect(runs.count).toBe(2)
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
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      async data() {
        calls++
        await g.hold()
        return { ok: true }
      }
    }
    void [GoneController]

    const store = new WatchedStore(new Forgetful())
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store).observer(recording.observer)))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.request('/sf-gone/data')
    await g.seen
    const follower = app.request('/sf-gone/data')
    await store.reads.reached(2)
    await turn()
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
      @CacheControl({ ttl: 60 * Second })
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

    const leader = app.request('/sf-fresh/data')
    await g.seen
    const follower = app.request('/sf-fresh/data', { headers: { 'cache-control': 'min-fresh=120' } })
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
      @CacheControl({ ttl: 60 * Second })
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

    const store = new WatchedStore(new FailsOnReread())
    const recording = new Recording()
    const errors: { operation: string; error: unknown }[] = []
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(store).observer({ ...recording.observer, onError: event => errors.push(event) })),
    )
    close = () => app.close()
    await app.bootstrap()

    const leader = app.request('/sf-reread/data')
    await g.seen
    const follower = app.request('/sf-reread/data')
    await store.reads.reached(2)
    await turn()
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
    const runs = counter()
    const g = gate()

    @Controller('/sf-head-leads')
    class HeadLeadsController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      async data() {
        runs.tick()
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

    const head = app.request('/sf-head-leads/data', { method: 'HEAD' })
    await g.seen
    const get = app.request('/sf-head-leads/data')
    // The GET is in the handler while the HEAD is still held there.
    await runs.reached(2)
    g.open()
    await Promise.all([head, get])

    expect(runs.count).toBe(2)
    expect(recording.reasons()).toEqual(['absent', 'absent'])
  })

  it('does follow a GET, and is answered with the GET length and no body', async () => {
    const g = gate()

    @Controller('/sf-head-follows')
    class HeadFollowsController {
      @CacheControl({ ttl: 60 * Second })
      @Get('/data')
      async data() {
        await g.hold()
        return { value: 'x'.repeat(50) }
      }
    }
    void [HeadFollowsController]

    const store = new WatchedStore()
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(store).observer(recording.observer)))
    close = () => app.close()
    await app.bootstrap()

    const leader = app.request('/sf-head-follows/data')
    await g.seen
    const head = app.request('/sf-head-follows/data', { method: 'HEAD' })
    await store.reads.reached(2)
    await turn()
    g.open()
    const [get, headRes] = await Promise.all([leader, head])

    expect(headRes.headers.get('x-cache')).toBe('HIT')
    expect(headRes.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(await headRes.text()).toBe('')
    expect(recording.coalesced).toBe(1)
  })

  it('leaves a route with its own HEAD handler to the HEAD handler', async () => {
    let heads = 0

    @CacheControl({ ttl: 60 * Second })
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

    await app.request('/sf-own-head/data', { method: 'HEAD' })
    await app.request('/sf-own-head/data', { method: 'HEAD' })

    expect(heads).toBe(2)
  })
})

/**
 * A leader reports back from its store hook. When that hook never runs — a hijacked reply, a handler that never
 * returns — `lockTimeout` alone releases the requests waiting on its run.
 */
describe('a handler run its leader does not report back on in time', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  async function start(options: {
    lockTimeout: number
    hijack?: boolean
    handler?: (request: { signal: AbortSignal }) => Promise<unknown>
  }) {
    const store = new WatchedStore()
    const recording = new Recording()
    const server = fastify()
    close = () => server.close()
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: recording.observer,
        flights: new Map(),
        lockTimeout: options.lockTimeout,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 * Second } },
      handler: options.hijack
        ? (_request, reply) => {
            reply.hijack()
            reply.raw.end('raw')
          }
        : (options.handler ?? (() => Promise.resolve({ ok: true }))),
    })
    await server.ready()

    return { server, store, recording }
  }

  // Hooks do not run after a hijack, so nothing but lockTimeout releases the requests waiting on the run.
  it('releases the requests waiting on a leader that hijacked its reply at lockTimeout, and no sooner', async () => {
    const { server, store, recording } = await start({ lockTimeout: 50, hijack: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    expect((await server.inject('/data')).body).toBe('raw')
    let answered = false
    const follower = server.inject('/data').then(res => {
      answered = true
      return res
    })
    await store.reads.reached(2)
    await turn()

    await vi.advanceTimersByTimeAsync(49)
    expect(answered).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect((await follower).body).toBe('raw')
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced'])

    // The run is over for good: a request arriving now finds nothing to wait on, and leads.
    await server.inject('/data')
    expect(recording.reasons()).toEqual(['absent', 'not-coalesced', 'absent'])
  })

  it('still stores what a leader produces after lockTimeout released the requests behind it', async () => {
    const g = gate()
    let calls = 0
    const { server } = await start({
      lockTimeout: 30,
      handler: async () => {
        calls++
        if (calls === 1) {
          await g.hold()
        }
        return { arrival: calls }
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const slow = server.inject('/data')
    await g.seen
    await vi.advanceTimersByTimeAsync(30)
    g.open()
    await slow

    const res = await server.inject('/data')
    expect(res.headers['x-cache']).toBe('HIT')
    expect(res.json()).toEqual({ arrival: 1 })
    expect(calls).toBe(1)
  })

  // A leader past lockTimeout still reports back when it finishes, first come first served, and that report only
  // ever ends its own run: a newer leader's run under the same key, with a request waiting on it, is not its to end.
  it('lets a leader that outlived lockTimeout end only its own run, never a newer one', async () => {
    const gates = [gate(), gate()]
    let arrivals = 0
    const { server, store, recording } = await start({
      lockTimeout: 30,
      handler: async () => {
        const mine = arrivals++
        if (mine < gates.length) {
          await gates[mine].hold()
        }
        if (mine === 0) {
          throw new Error('the slow leader failed')
        }
        return { arrival: mine }
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const slow = server.inject('/data')
    await gates[0].seen
    await vi.advanceTimersByTimeAsync(30)

    const next = server.inject('/data')
    await gates[1].seen
    gates[0].open()
    expect((await slow).statusCode).toBe(500)

    const follower = server.inject('/data')
    await store.reads.reached(3)
    await turn()
    gates[1].open()
    const [led, followed] = await Promise.all([next, follower])

    expect(arrivals).toBe(2)
    expect(led.json()).toEqual({ arrival: 1 })
    expect(followed.headers['x-cache']).toBe('HIT')
    expect(followed.json()).toEqual({ arrival: 1 })
    expect(recording.coalesced).toBe(1)
    expect(recording.reasons()).toEqual(['absent', 'absent'])
  })

  it('still stores and releases the requests behind a leader whose client went away', async () => {
    const g = gate()
    let leaderSignal: AbortSignal | undefined
    const { server, store, recording } = await start({
      lockTimeout: 1000,
      handler: async request => {
        leaderSignal ??= request.signal
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
    await store.reads.reached(2)
    await turn()

    socket.destroy()
    await whenAborted(leaderSignal!)
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

  async function start(options: {
    lockTimeout: number
    handlerTimeout?: number
    hijack?: boolean
    handler?: () => Promise<unknown>
  }) {
    const store = new WatchedStore()
    const recording = new Recording()
    const server = fastify(options.handlerTimeout === undefined ? {} : { handlerTimeout: options.handlerTimeout })
    close = () => server.close()
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: recording.observer,
        flights: new Map(),
        lockTimeout: options.lockTimeout,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 * Second } },
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
    const runs = counter()
    const g = gate()
    const { server, store, recording } = await start({
      lockTimeout: 1000,
      handler: async () => {
        runs.tick()
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
    await store.reads.reached(2)
    await turn()
    expect(runs.count).toBe(1)

    // The follower gives up its wait and, with the gate still closed, enters the handler itself.
    socket.destroy()
    await runs.reached(2)
    expect(store.reads.count).toBe(2)

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
        lockTimeout: 60_000,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 * Second } },
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
    const { server, store, recording } = await start({ lockTimeout: 200, handlerTimeout: 40, hijack: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // The leader hijacks, which clears its own timeout and settles its flight only at lockTimeout.
    const leader = await server.inject('/data')
    expect(leader.body).toBe('raw')

    const follower = server.inject('/data')
    await store.reads.reached(2)
    await turn()
    await vi.advanceTimersByTimeAsync(40)
    expect((await follower).statusCode).toBe(503)

    await vi.advanceTimersByTimeAsync(160)
    expect(store.reads.count).toBe(2)
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
