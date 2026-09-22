import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import {
  ErrCacheStoreTimeout,
  cachePlugin,
  type CacheErrorEvent,
  type HTTPCacheCallOptions,
  type HTTPCacheEntry,
  type HTTPCacheGetOptions,
  type HTTPCachePutOptions,
  type HTTPCacheStore,
} from '../index.js'

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
    await close?.()
    close = undefined
  })

  async function start(store: RecordingStore, options: { storeTimeoutMs?: number; handlerTimeout?: number } = {}) {
    const errors: CacheErrorEvent[] = []
    const server = fastify(options.handlerTimeout === undefined ? {} : { handlerTimeout: options.handlerTimeout })
    close = () => server.close()
    await server.register(
      cachePlugin({
        store,
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: { onError: event => errors.push(event) },
        storeTimeoutMs: options.storeTimeoutMs,
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      config: { cache: { ttl: 60, tags: ['data'] } },
      handler: () => ({ ok: true }),
    })
    server.route({
      method: 'POST',
      url: '/data',
      config: { cacheInvalidate: { tags: ['data'] } },
      handler: () => ({ ok: true }),
    })
    await server.ready()

    return { server, errors }
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
    const { server, errors } = await start(store, { storeTimeoutMs: 20 })

    const res = await server.inject('/data')

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('MISS')
    expect(store.signalOf('get')?.aborted).toBe(true)
    expect(store.signalOf('put')?.aborted).toBe(true)
    expect(errors.map(event => event.operation)).toEqual(['get', 'put'])
    for (const event of errors) {
      expect(event.error).toBeInstanceOf(ErrCacheStoreTimeout)
    }
  })

  // Fastify answers 503 and aborts the request signal; the read stops with it, and it is not a store failure.
  it('lets a handler timeout take the read out, and reports nothing', async () => {
    const store = new RecordingStore()
    store.hang = true
    const { server, errors } = await start(store, { handlerTimeout: 50 })

    const res = await server.inject('/data')

    expect(res.statusCode).toBe(503)
    expect(store.signalOf('get')?.aborted).toBe(true)
    expect((store.signalOf('get')?.reason as { code?: string }).code).toBe('FST_ERR_HANDLER_TIMEOUT')
    expect(errors).toEqual([])
  })

  it('lets a client that disconnects take the read out, and reports nothing', async () => {
    const store = new RecordingStore()
    store.hang = true
    const { server, errors } = await start(store)
    await server.listen({ port: 0, host: '127.0.0.1' })
    const { port } = server.server.address() as { port: number }

    const socket = connect({ host: '127.0.0.1', port })
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write('GET /data HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await waitFor(() => store.calls.some(call => call.verb === 'get'))
    expect(store.signalOf('get')?.aborted).toBe(false)

    socket.destroy()
    await waitFor(() => store.signalOf('get')?.aborted === true)

    await sleep(20)
    expect(errors).toEqual([])
  })
})

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) {
      return
    }
    await sleep(5)
  }
  throw new Error('Condition not met in time')
}

// `FastifyInstance` is imported so the helper's return type is nameable; the route config is what the plugin reads.
export type { FastifyInstance }
