import { connect } from 'node:net'

import { Controller, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Second } from '@caffeinejs/std/duration'
import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import {
  CacheControl,
  ErrCacheStoreTimeout,
  HTTPCaching,
  cachePlugin,
  type CacheErrorEvent,
  type HTTPCacheCallOptions,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCachePutOptions,
  type HTTPCacheStore,
} from '../index.js'
import { WatchedStore, turn, whenAborted } from './_latch.js'

/** Keeps every call with the signal it was handed. `hang` makes a call settle only through that signal. */
class RecordingStore implements HTTPCacheStore {
  readonly inner = new MemoryHTTPCacheStore()
  readonly calls: { verb: 'get' | 'put' | 'evict'; signal: AbortSignal | undefined }[] = []
  hang = false

  get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    this.calls.push({ verb: 'get', signal: options?.signal })
    return this.hang ? this.#untilAborted(options) : this.inner.get(key, options)
  }

  put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    this.calls.push({ verb: 'put', signal: options.signal })
    return this.hang ? this.#untilAborted(options) : this.inner.put(key, entry, options)
  }

  evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    this.calls.push({ verb: 'evict', signal: options?.signal })
    return this.inner.evictByTag(tags, options)
  }

  // What a client does with a queued command: nothing, until the signal takes it out.
  #untilAborted<T>(options: HTTPCacheCallOptions | undefined): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })
  }

  signalOf(verb: 'get' | 'put' | 'evict', index = 0): AbortSignal | undefined {
    return this.calls.filter(call => call.verb === verb)[index]?.signal
  }
}

/**
 * On a server the adapter does not drive, so what is checked is the hooks' own doing: which signal each store
 * call is handed, and what the cache reports when one aborts.
 */
describe('the signal a store call carries', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  async function start(store: HTTPCacheStore, options: { storeTimeout?: number; handlerTimeout?: number } = {}) {
    const errors: CacheErrorEvent[] = []
    const sends = { n: 0 }
    const handled = { n: 0 }
    const server = fastify(options.handlerTimeout === undefined ? {} : { handlerTimeout: options.handlerTimeout })
    close = () => server.close()
    // Ahead of the cache's own store hook, and finishing through `done` as that one does: what is counted is
    // every send Fastify starts, and nothing here holds one open.
    server.addHook('onSend', (_request, _reply, payload, done) => {
      sends.n++
      done(null, payload)
    })
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: { onError: event => errors.push(event) },
        storeTimeout: options.storeTimeout,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60 * Second, tags: ['data'] } },
      handler: () => {
        handled.n++
        return { ok: true }
      },
    })

    server.route({
      method: 'POST',
      url: '/data',
      config: { cacheInvalidate: { tags: ['data'] } },
      handler: () => ({ ok: true }),
    })
    await server.ready()

    return { server, errors, sends, handled }
  }

  it('hands a read the request signal and a write no signal at all, with no storeTimeout', async () => {
    const store = new RecordingStore()
    const { server, errors } = await start(store)

    await server.inject('/data')
    await server.inject({ method: 'POST', url: '/data' })

    expect(store.calls.map(call => call.verb)).toEqual(['get', 'put', 'evict'])
    expect(store.signalOf('get')).toBeInstanceOf(AbortSignal)
    expect(store.signalOf('get')?.aborted).toBe(false)
    expect(store.signalOf('put')).toBeUndefined()
    expect(store.signalOf('evict')).toBeUndefined()
    expect(errors).toEqual([])
  })

  // The store is handed a signal that aborts at the timeout, so a client drops the command. What the store
  // rejects with then is its own business: the cache reports the timeout.
  it('aborts the signal after storeTimeout, and reports the timeout whatever the store rejected with', async () => {
    const store = new RecordingStore()
    store.hang = true
    const watched = new WatchedStore(store)
    const { server, errors } = await start(watched, { storeTimeout: 20 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = server.inject('/data')
    await watched.reads.reached(1)
    await vi.advanceTimersByTimeAsync(19)
    expect(store.signalOf('get')?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await watched.writes.reached(1)
    await vi.advanceTimersByTimeAsync(20)
    const res = await pending

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('MISS')
    expect(store.signalOf('get')?.aborted).toBe(true)
    expect(store.signalOf('put')?.aborted).toBe(true)
    expect(errors.map(event => event.operation)).toEqual(['get', 'put'])
    for (const event of errors) {
      expect(event.error).toBeInstanceOf(ErrCacheStoreTimeout)
    }
  })

  // A store method written without `async` throws instead of rejecting. It costs the cache, not the request, as a
  // rejection does, and is reported as what it threw: nothing waited for it to time out.
  it('treats a store method that throws like one that rejects', async () => {
    const thrown = { get: new Error('get threw'), put: new Error('put threw'), evict: new Error('evict threw') }
    const store: HTTPCacheStore = {
      get() {
        throw thrown.get
      },
      put() {
        throw thrown.put
      },
      evictByTag() {
        throw thrown.evict
      },
    }
    const { server, errors } = await start(store, { storeTimeout: 60_000 })

    const read = await server.inject('/data')
    const mutation = await server.inject({ method: 'POST', url: '/data' })

    expect(read.statusCode).toBe(200)
    expect(read.headers['x-cache']).toBe('MISS')
    expect(mutation.statusCode).toBe(200)
    expect(errors.map(event => [event.operation, event.error])).toEqual([
      ['get', thrown.get],
      ['put', thrown.put],
      ['evict', thrown.evict],
    ])
  })

  // Fastify answers 503 and aborts the request signal; the read stops with it, and it is not a store failure.
  // The 503 is over before the read hook returns, since the store hook finished it through `done` rather than
  // a promise, so the lifecycle stops there: the handler never runs, and nothing is sent a second time.
  it('lets a handler timeout take the read out, and reports nothing', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const store = new RecordingStore()
    store.hang = true
    const watched = new WatchedStore(store)
    const { server, errors, sends, handled } = await start(watched, { handlerTimeout: 50 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const pending = server.inject('/data')
      await watched.reads.reached(1)
      await vi.advanceTimersByTimeAsync(50)
      const res = await pending

      expect(res.statusCode).toBe(503)
      expect(store.signalOf('get')?.aborted).toBe(true)
      expect((store.signalOf('get')!.reason as { code?: string }).code).toBe('FST_ERR_HANDLER_TIMEOUT')
      expect(errors).toEqual([])

      await turn()
      expect(handled.n).toBe(0)
      expect(sends.n).toBe(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  })

  it('lets a client that disconnects take the read out, and reports nothing', async () => {
    const store = new RecordingStore()
    store.hang = true
    const watched = new WatchedStore(store)
    const { server, errors } = await start(watched)
    await server.listen({ port: 0, host: '127.0.0.1' })
    const { port } = server.server.address() as { port: number }

    const socket = connect({ host: '127.0.0.1', port })
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write('GET /data HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await watched.reads.reached(1)
    expect(store.signalOf('get')?.aborted).toBe(false)

    socket.destroy()
    await whenAborted(store.signalOf('get')!)

    await turn()
    expect(errors).toEqual([])
  })
})

describe('storeTimeout on HTTPCaching', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  // A store that neither answers nor rejects — a client queueing commands for a server that is away — would
  // otherwise hold every request on a cached route for as long as the request itself lasts.
  it('defaults to 2s: a read that never answers is given up on then, and the request goes on', async () => {
    @Controller('/default-timeout')
    class DefaultTimeoutController {
      @Get('/data')
      @CacheControl({ ttl: 60 * Second })
      data() {
        return { ok: true }
      }
    }
    void [DefaultTimeoutController]

    const errors: CacheErrorEvent[] = []
    const store = new WatchedStore({
      get: (_key, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
        }),
      put: () => Promise.resolve(),
      evictByTag: () => Promise.resolve(),
    })
    const app = createWebApplication().with(HTTPCaching(b => b.store(store).observer({ onError: e => errors.push(e) })))
    close = () => app.close()
    await app.bootstrap()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    let answered = false
    const pending = app.fetch('/default-timeout/data').then(res => {
      answered = true
      return res
    })
    await store.reads.reached(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(answered).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const res = await pending

    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(errors).toHaveLength(1)
    expect(errors[0].operation).toBe('get')
    expect(errors[0].error).toBeInstanceOf(ErrCacheStoreTimeout)
    expect((errors[0].error as Error).message).toContain('2000ms')
  })
})
