import { $p, Args, Controller, Get, Header, createWebApplication, type Context } from '@caffeinejs/http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import {
  CacheControl,
  HTTPCaching,
  type CacheHitEvent,
  type CacheMissEvent,
  type CacheStaleIfErrorEvent,
  type CacheStoreEvent,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCachePutOptions,
  type HTTPCacheStore,
} from '../index.js'

/** A handler that waits to be let go, so requests pile up behind it on purpose. */
function gate() {
  let open!: () => void
  let entered!: () => void
  const opened = new Promise<void>(resolve => (open = resolve))
  const seen = new Promise<void>(resolve => (entered = resolve))

  return {
    open,
    seen,
    async hold() {
      entered()
      await opened
    },
  }
}

class Recording {
  readonly hits: CacheHitEvent[] = []
  readonly misses: CacheMissEvent[] = []
  readonly stores: CacheStoreEvent[] = []
  readonly rescues: CacheStaleIfErrorEvent[] = []
  readonly observer = {
    onHit: (event: CacheHitEvent) => this.hits.push(event),
    onMiss: (event: CacheMissEvent) => this.misses.push(event),
    onStore: (event: CacheStoreEvent) => this.stores.push(event),
    onStaleIfError: (event: CacheStaleIfErrorEvent) => this.rescues.push(event),
  }
}

/** Keeps what `put` was asked to keep the entry for. */
class RetentionSpy implements HTTPCacheStore {
  readonly inner = new MemoryHTTPCacheStore()
  readonly retentions: unknown[] = []
  get(key: string, options?: HTTPCacheGetOptions) {
    return this.inner.get(key, options)
  }
  put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions) {
    this.retentions.push(options.ttl)
    return this.inner.put(key, entry, options)
  }
  evictByTag(tags: string | readonly string[]) {
    return this.inner.evictByTag(tags)
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Only the clock the cache reads an entry's age from is moved; the store's own ttl and the flight's timer run on
// real time, and the handler never waits on a faked timer.
function age(seconds: number) {
  vi.setSystemTime(Date.now() + seconds * 1000)
}

describe('stale-while-revalidate, served by the store', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  it('serves followers the stale entry while the leader refreshes it, and marks it so', async () => {
    let calls = 0
    const g = gate()

    @Controller('/swr-followers')
    class FollowersController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 30 })
      @Get('/data')
      async data() {
        calls++
        if (calls > 1) {
          await g.hold()
        }
        return { n: calls }
      }
    }
    void [FollowersController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/swr-followers/data')
    age(70)

    const leader = app.fetch('/swr-followers/data')
    await g.seen
    const follower = await app.fetch('/swr-followers/data')

    expect(follower.headers.get('x-cache')).toBe('STALE')
    expect(follower.headers.get('age')).toBe('70')
    expect(follower.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=30')
    expect(await follower.json()).toEqual({ n: 1 })

    g.open()
    const led = await leader
    expect(led.headers.get('x-cache')).toBe('MISS')
    expect(await led.json()).toEqual({ n: 2 })

    const fresh = await app.fetch('/swr-followers/data')
    expect(fresh.headers.get('x-cache')).toBe('HIT')
    expect(await fresh.json()).toEqual({ n: 2 })

    expect(recording.hits.map(hit => [hit.stale, hit.coalesced])).toEqual([
      [true, false],
      [false, false],
    ])
    expect(recording.misses.map(miss => miss.reason)).toEqual(['absent', 'expired'])
  })

  it('serves nobody stale on a route without the lock: every request runs the handler', async () => {
    let calls = 0
    const g = gate()

    @Controller('/swr-unlocked')
    class UnlockedController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 30, lock: false })
      @Get('/data')
      async data() {
        calls++
        if (calls > 1) {
          await g.hold()
        }
        return { n: calls }
      }
    }
    void [UnlockedController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/swr-unlocked/data')
    age(70)

    const first = app.fetch('/swr-unlocked/data')
    await g.seen
    const second = app.fetch('/swr-unlocked/data')
    await sleep(10)
    g.open()
    const responses = await Promise.all([first, second])

    expect(responses.map(res => res.headers.get('x-cache'))).toEqual(['MISS', 'MISS'])
    expect(calls).toBe(3)
  })

  it('makes followers wait once the window is over, and forbids it under mustRevalidate', async () => {
    let calls = 0
    const gates = { over: gate(), forbidden: gate() }

    @Controller('/swr-limits')
    class LimitsController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 30 })
      @Get('/over')
      async over() {
        calls++
        if (calls > 1) {
          await gates.over.hold()
        }
        return { n: calls }
      }

      @CacheControl({ ttl: 60, staleWhileRevalidate: 30, mustRevalidate: true })
      @Get('/forbidden')
      async forbidden() {
        calls++
        if (calls > 1) {
          await gates.forbidden.hold()
        }
        return { n: calls }
      }
    }
    void [LimitsController]

    const spy = new RetentionSpy()
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(spy).observer(recording.observer)))
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/swr-limits/over')
    age(100)
    calls = 1
    const overLeader = app.fetch('/swr-limits/over')
    await gates.over.seen
    const overFollower = app.fetch('/swr-limits/over')
    await sleep(10)
    gates.over.open()
    const [, overFollowed] = await Promise.all([overLeader, overFollower])
    expect(overFollowed.headers.get('x-cache')).toBe('HIT')
    expect(recording.hits.at(-1)).toMatchObject({ coalesced: true, stale: false })

    calls = 0
    await app.fetch('/swr-limits/forbidden')
    age(70)
    calls = 1
    const forbiddenLeader = app.fetch('/swr-limits/forbidden')
    await gates.forbidden.seen
    const forbiddenFollower = app.fetch('/swr-limits/forbidden')
    await sleep(10)
    gates.forbidden.open()
    const [, forbiddenFollowed] = await Promise.all([forbiddenLeader, forbiddenFollower])
    expect(forbiddenFollowed.headers.get('x-cache')).toBe('HIT')
    expect(recording.hits.at(-1)).toMatchObject({ coalesced: true, stale: false })

    // The store keeps an entry for the freshness lifetime and the stale window; none under mustRevalidate.
    expect(spy.retentions).toEqual([90, 90, 60, 60])
  })

  // The other two directives that require revalidation: the same rule, and the window is not announced either.
  it('forbids it under proxyRevalidate and noCache too, and tells no cache downstream otherwise', async () => {
    const calls = { proxy: 0, nocache: 0 }

    @Controller('/swr-revalidate')
    class RevalidateController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 30, staleIfError: 300, proxyRevalidate: true })
      @Get('/proxy')
      proxy() {
        return { n: ++calls.proxy }
      }

      @CacheControl({ ttl: 60, staleWhileRevalidate: 30, staleIfError: 300, noCache: true })
      @Get('/nocache')
      nocache() {
        return { n: ++calls.nocache }
      }
    }
    void [RevalidateController]

    const spy = new RetentionSpy()
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(spy).observer(recording.observer)))
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    const proxy = await app.fetch('/swr-revalidate/proxy')
    const nocache = await app.fetch('/swr-revalidate/nocache')
    expect(proxy.headers.get('cache-control')).toBe('public, proxy-revalidate, max-age=60')
    expect(nocache.headers.get('cache-control')).toBe('no-cache, public, max-age=60')
    age(70)

    // A client that would take a stale entry is not given one: the handler runs.
    const proxyAgain = await app.fetch('/swr-revalidate/proxy', { headers: { 'cache-control': 'max-stale' } })
    const nocacheAgain = await app.fetch('/swr-revalidate/nocache', { headers: { 'cache-control': 'max-stale' } })
    expect(proxyAgain.headers.get('x-cache')).toBe('MISS')
    expect(nocacheAgain.headers.get('x-cache')).toBe('MISS')
    expect(calls).toEqual({ proxy: 2, nocache: 2 })
    expect(recording.hits).toEqual([])

    // Kept for the freshness lifetime alone.
    expect(spy.retentions).toEqual([60, 60, 60, 60])
  })

  it('keeps an entry for the longer of the two windows when a route declares both', async () => {
    let calls = 0
    let failing = false
    const g = gate()

    @Controller('/swr-sie')
    class BothController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 30, staleIfError: 300 })
      @Get('/data')
      async data() {
        calls++
        if (failing) {
          throw new Error('backend down')
        }
        if (calls === 2) {
          await g.hold()
        }
        return { n: calls }
      }
    }
    void [BothController]

    const spy = new RetentionSpy()
    const recording = new Recording()
    const app = createWebApplication().with(HTTPCaching(b => b.store(spy).observer(recording.observer)))
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/swr-sie/data')
    age(70)

    // Within stale-while-revalidate: the follower is served the entry while the leader refreshes it.
    const leader = app.fetch('/swr-sie/data')
    await g.seen
    const follower = await app.fetch('/swr-sie/data')
    expect(follower.headers.get('x-cache')).toBe('STALE')
    expect(await follower.json()).toEqual({ n: 1 })
    g.open()
    expect((await leader).headers.get('x-cache')).toBe('MISS')

    // Past stale-while-revalidate, within stale-if-error: the refreshed entry stands in for the failure.
    age(100)
    failing = true
    const rescued = await app.fetch('/swr-sie/data')
    expect(rescued.status).toBe(200)
    expect(rescued.headers.get('x-cache')).toBe('STALE')
    expect(await rescued.json()).toEqual({ n: 2 })

    expect(recording.rescues).toHaveLength(1)
    expect(spy.retentions).toEqual([360, 360])
  })

  it('never serves stale to a request the entry does not satisfy, nor to only-if-cached', async () => {
    let calls = 0
    let holding = false
    const g = gate()

    @Controller('/swr-request')
    class RequestController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 300 })
      @Get('/data')
      async data() {
        calls++
        if (holding) {
          await g.hold()
        }
        return { n: calls }
      }
    }
    void [RequestController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/swr-request/data')
    age(50)
    const wantsFresher = await app.fetch('/swr-request/data', { headers: { 'cache-control': 'min-fresh=30' } })
    expect(wantsFresher.headers.get('x-cache')).toBe('MISS')
    expect(recording.misses.at(-1)?.reason).toBe('stale-for-request')

    // That miss stored a fresh entry; past its ttl again, and well within the stale window.
    age(70)
    holding = true
    const leader = app.fetch('/swr-request/data')
    await g.seen
    const impatient = await app.fetch('/swr-request/data', { headers: { 'cache-control': 'only-if-cached' } })
    // Too old for this request: it waits for the leader's fresh entry rather than take the stale one.
    const strict = app.fetch('/swr-request/data', { headers: { 'cache-control': 'max-age=10' } })
    await sleep(10)
    g.open()
    await leader
    const waited = await strict

    expect(impatient.status).toBe(504)
    expect(waited.headers.get('x-cache')).toBe('HIT')
    expect(recording.hits.filter(hit => hit.stale)).toEqual([])
    expect(recording.hits.at(-1)).toMatchObject({ coalesced: true })
  })
})

describe('max-stale, asked for by the client', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  // A client that accepts a stale entry is served what the route keeps, at once — no leader, no wait — and
  // only as stale as it said. A route that requires revalidation, or keeps nothing past its ttl, has nothing to
  // give it.
  it('serves the stale entry the route keeps at once, within what the client accepts, and never on a route that revalidates', async () => {
    const calls = { window: 0, strict: 0, plain: 0 }

    @Controller('/max-stale')
    class MaxStaleController {
      @CacheControl({ ttl: 60, staleWhileRevalidate: 300 })
      @Get('/window')
      window() {
        return { n: ++calls.window }
      }

      @CacheControl({ ttl: 60, staleWhileRevalidate: 300, mustRevalidate: true })
      @Get('/strict')
      strict() {
        return { n: ++calls.strict }
      }

      @CacheControl({ ttl: 60 })
      @Get('/plain')
      plain() {
        return { n: ++calls.plain }
      }
    }
    void [MaxStaleController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.ready()
    const fetch = (path: string, cacheControl?: string) =>
      app.fetch(`/max-stale/${path}`, cacheControl === undefined ? {} : { headers: { 'cache-control': cacheControl } })

    vi.useFakeTimers({ toFake: ['Date'] })
    await fetch('window')
    await fetch('strict')
    await fetch('plain')
    age(70)

    const any = await fetch('window', 'max-stale')
    expect(any.headers.get('x-cache')).toBe('STALE')
    expect(any.headers.get('age')).toBe('70')
    expect(await any.json()).toEqual({ n: 1 })
    expect(recording.hits.at(-1)).toMatchObject({ stale: true, coalesced: false, ageSeconds: 70 })

    const cached = await fetch('window', 'only-if-cached, max-stale=100')
    expect(cached.status).toBe(200)
    expect(cached.headers.get('x-cache')).toBe('STALE')

    // Stale by ten seconds, which is more than this client accepts: the handler runs.
    const tooStale = await fetch('window', 'max-stale=5')
    expect(tooStale.headers.get('x-cache')).toBe('MISS')
    expect(await tooStale.json()).toEqual({ n: 2 })
    expect(recording.misses.at(-1)?.reason).toBe('expired')

    const revalidates = await fetch('strict', 'max-stale')
    expect(revalidates.headers.get('x-cache')).toBe('MISS')
    expect(await revalidates.json()).toEqual({ n: 2 })

    const nothingKept = await fetch('plain', 'max-stale')
    expect(nothingKept.headers.get('x-cache')).toBe('MISS')
    expect(await nothingKept.json()).toEqual({ n: 2 })

    expect(calls).toEqual({ window: 2, strict: 2, plain: 2 })
  })
})

describe('stale-if-error, served by the store', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  let failing = false

  @Controller('/sie')
  class SIEController {
    @CacheControl({ ttl: 60, staleIfError: 300 })
    @Header('Content-Language', 'en')
    @Get('/data')
    data() {
      if (failing) {
        throw new Error('backend down')
      }
      return { ok: true }
    }

    @CacheControl({ ttl: 60, staleIfError: 300 })
    @Get('/gateway')
    @Args([$p.context()])
    gateway(ctx: Context) {
      if (failing) {
        ctx.status(503)
        ctx.header('Retry-After', '30')
        ctx.header('Content-Type', 'text/plain')
        return 'down'
      }
      return { ok: true }
    }

    @CacheControl({ ttl: 60, staleIfError: 300 })
    @Get('/missing')
    @Args([$p.context()])
    missing(ctx: Context) {
      if (failing) {
        ctx.status(404)
        return { error: 'gone' }
      }
      return { ok: true }
    }

    @CacheControl({ ttl: 60 })
    @Get('/plain')
    plain() {
      if (failing) {
        throw new Error('backend down')
      }
      return { ok: true }
    }
  }
  void [SIEController]

  async function start() {
    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.ready()
    failing = false
    vi.useFakeTimers({ toFake: ['Date'] })

    return { app, recording }
  }

  it('replaces a 5xx the handler produced with the stale entry, stores nothing, and says so', async () => {
    const { app, recording } = await start()

    const stored = await app.fetch('/sie/data')
    age(100)
    failing = true

    const rescued = await app.fetch('/sie/data')

    expect(rescued.status).toBe(200)
    expect(rescued.headers.get('x-cache')).toBe('STALE')
    expect(rescued.headers.get('age')).toBe('100')
    expect(rescued.headers.get('content-language')).toBe('en')
    expect(rescued.headers.get('content-type')).toBe(stored.headers.get('content-type'))
    expect(rescued.headers.get('etag')).toBe(stored.headers.get('etag'))
    expect(rescued.headers.get('cache-control')).toBe('public, max-age=60, stale-if-error=300')
    expect(await rescued.json()).toEqual({ ok: true })

    expect(recording.stores).toHaveLength(1)
    expect(recording.misses.map(miss => miss.reason)).toEqual(['absent', 'expired'])
    expect(recording.rescues).toMatchObject([{ route: { url: '/sie/data' }, ageSeconds: 100, replaced: 500 }])
    expect(recording.hits).toEqual([])
  })

  it('writes the stored headers over the error response, and drops its Retry-After', async () => {
    const { app } = await start()

    const stored = await app.fetch('/sie/gateway')
    age(100)
    failing = true

    const rescued = await app.fetch('/sie/gateway')

    expect(rescued.status).toBe(200)
    expect(rescued.headers.get('content-type')).toBe(stored.headers.get('content-type'))
    expect(rescued.headers.get('content-length')).toBe(stored.headers.get('content-length'))
    expect(rescued.headers.get('retry-after')).toBeNull()
    expect(await rescued.json()).toEqual({ ok: true })
  })

  it('leaves a 4xx, an error past the window, and an error on a route without the window alone', async () => {
    const { app } = await start()

    await app.fetch('/sie/missing')
    await app.fetch('/sie/data')
    await app.fetch('/sie/plain')
    failing = true

    age(100)
    expect((await app.fetch('/sie/missing')).status).toBe(404)
    expect((await app.fetch('/sie/plain')).status).toBe(500)

    age(300)
    const late = await app.fetch('/sie/data')
    expect(late.status).toBe(500)
    expect(late.headers.get('x-cache')).toBe('MISS')
  })

  it('answers the HEAD twin from the entry, with its length and no body', async () => {
    const { app } = await start()

    const stored = await app.fetch('/sie/data')
    age(100)
    failing = true

    const head = await app.fetch('/sie/data', { method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(head.headers.get('x-cache')).toBe('STALE')
    expect(head.headers.get('content-length')).toBe(stored.headers.get('content-length'))
    expect(await head.text()).toBe('')
  })

  it('answers 304 to a client that already holds the entry', async () => {
    const { app } = await start()

    const stored = await app.fetch('/sie/data')
    age(100)
    failing = true

    const revalidated = await app.fetch('/sie/data', { headers: { 'if-none-match': stored.headers.get('etag')! } })

    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('x-cache')).toBe('STALE')
    expect(await revalidated.text()).toBe('')

    const head = await app.fetch('/sie/data', {
      method: 'HEAD',
      headers: { 'if-none-match': stored.headers.get('etag')! },
    })
    expect(head.status).toBe(304)
    expect(head.headers.get('x-cache')).toBe('STALE')
    expect(await head.text()).toBe('')
  })

  it('serves the followers of a rescued leader the same stale entry', async () => {
    let calls = 0
    const g = gate()

    @Controller('/sie-followers')
    class SIEFollowersController {
      @CacheControl({ ttl: 60, staleIfError: 300 })
      @Get('/data')
      async data() {
        calls++
        if (calls > 1) {
          await g.hold()
          throw new Error('backend down')
        }
        return { n: calls }
      }
    }
    void [SIEFollowersController]

    const recording = new Recording()
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).observer(recording.observer)),
    )
    close = () => app.close()
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    await app.fetch('/sie-followers/data')
    age(100)

    const leader = app.fetch('/sie-followers/data')
    await g.seen
    const follower = app.fetch('/sie-followers/data')
    await sleep(10)
    g.open()
    const [led, followed] = await Promise.all([leader, follower])

    expect(led.headers.get('x-cache')).toBe('STALE')
    expect(followed.headers.get('x-cache')).toBe('STALE')
    expect(await followed.json()).toEqual({ n: 1 })
    expect(calls).toBe(2)
    expect(recording.hits).toMatchObject([{ stale: true, coalesced: true }])
    expect(recording.rescues).toHaveLength(1)
  })
})
