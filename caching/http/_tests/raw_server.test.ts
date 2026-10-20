import { Readable } from 'node:stream'

import { Second } from '@caffeinejs/std/duration'
import fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { cachePlugin, type CacheStoreEvent } from '../index.js'

/** A streamed body, and whether the server-side resource behind it was let go. */
interface Streamed {
  body: unknown
  closed(): boolean
}

function nodeStream(): Streamed {
  const body = new Readable({ read() {} })
  return { body, closed: () => body.destroyed }
}

function webStream(cancel?: () => void): Streamed {
  let closed = false
  const body = new ReadableStream({
    cancel() {
      closed = true
      cancel?.()
    },
  })
  return { body, closed: () => closed }
}

function response(): Streamed {
  const { body, closed } = webStream()
  return { body: new Response(body as ReadableStream), closed }
}

/**
 * `cachePlugin` is a plain server plugin: given its dependencies it runs on a server no application drives, with
 * routes that declare caching in their `config`. No observer is required there, and none is assumed.
 */
describe('cachePlugin on a server the application does not drive', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  async function serve(route: (server: FastifyInstance) => void) {
    const server = fastify()
    close = () => server.close()
    await server.register(
      cachePlugin({ store: new MemoryHTTPCacheStore(), etagGenerator: undefined, statusHeader: 'X-Cache' }),
    )
    route(server)
    await server.ready()

    return server
  }

  // The server closes only the stream it sends. A streamed body the cache answers in place of would otherwise
  // keep the file, socket or upstream connection behind it open until it is collected.
  it.each([
    ['a Node stream', 'etag', nodeStream],
    ['a Node stream', 'last-modified', nodeStream],
    ['a web stream', 'etag', () => webStream()],
    ['a Response', 'etag', response],
  ])('closes %s it answers with a 304 on a matching %s', async (_kind, validator, make) => {
    const streamed = make()
    const lastModified = 'Mon, 01 Jan 2024 00:00:00 GMT'
    const server = await serve(s =>
      s.route({
        method: 'GET',
        url: '/file',
        config: { cache: { ttl: 60 * Second } },
        handler: (_request, reply) =>
          reply.header(validator, validator === 'etag' ? '"v1"' : lastModified).send(streamed.body),
      }),
    )

    const res = await server.inject({
      url: '/file',
      headers: validator === 'etag' ? { 'if-none-match': '"v1"' } : { 'if-modified-since': lastModified },
    })

    expect(res.statusCode).toBe(304)
    expect(streamed.closed()).toBe(true)
  })

  // Closing is best effort: a stream that fails to cancel is no reason to fail the response, or the process.
  it('answers the 304 when the stream it closes fails to cancel', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const streamed = webStream(() => {
        throw new Error('cannot cancel')
      })
      const server = await serve(s =>
        s.route({
          method: 'GET',
          url: '/file',
          config: { cache: { ttl: 60 * Second } },
          handler: (_request, reply) => reply.header('etag', '"v1"').send(streamed.body),
        }),
      )

      const res = await server.inject({ url: '/file', headers: { 'if-none-match': '"v1"' } })
      await new Promise(resolve => setImmediate(resolve))

      expect(res.statusCode).toBe(304)
      expect(streamed.closed()).toBe(true)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('closes a streamed 5xx it serves a stale entry in place of', async () => {
    let calls = 0
    const streamed = nodeStream()
    const server = await serve(s =>
      s.route({
        method: 'GET',
        url: '/flaky',
        config: { cache: { ttl: 60 * Second, staleIfError: 300 * Second } },
        handler: (_request, reply) => (++calls === 1 ? reply.send('fresh') : reply.code(503).send(streamed.body)),
      }),
    )
    vi.useFakeTimers({ toFake: ['Date'] })

    await server.inject('/flaky')
    vi.setSystemTime(Date.now() + 100_000)
    const res = await server.inject('/flaky')

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('STALE')
    expect(res.body).toBe('fresh')
    expect(streamed.closed()).toBe(true)
  })

  // A HEAD carries the length its GET would have had, which for bytes is their count, not a character count.
  it('gives a HEAD served a stale binary entry over a 5xx the length of its bytes', async () => {
    let calls = 0
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])
    const server = await serve(s =>
      s.route({
        method: 'GET',
        url: '/blob',
        config: { cache: { ttl: 60 * Second, staleIfError: 300 * Second } },
        handler: (_request, reply) =>
          ++calls === 1 ? reply.type('application/octet-stream').send(bytes) : reply.code(503).send('down'),
      }),
    )
    vi.useFakeTimers({ toFake: ['Date'] })

    await server.inject('/blob')
    vi.setSystemTime(Date.now() + 100_000)
    const res = await server.inject({ method: 'HEAD', url: '/blob' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('STALE')
    expect(res.headers['content-length']).toBe(String(bytes.length))
    expect(res.body).toBe('')
  })

  // A binary response is cached as the bytes it is, and its size reported in bytes, not in characters.
  it('stores a Buffer payload and replays it byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])
    const stored: CacheStoreEvent[] = []
    const server = fastify()
    close = () => server.close()
    await server.register(
      cachePlugin({
        store: new MemoryHTTPCacheStore(),
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: { onStore: event => stored.push(event) },
      }),
    )
    server.route({
      method: 'GET',
      url: '/blob',
      config: { cache: { ttl: 60 * Second } },
      handler: (_request, reply) => reply.type('application/octet-stream').send(bytes),
    })
    await server.ready()

    const miss = await server.inject('/blob')
    const hit = await server.inject('/blob')

    expect(miss.headers['x-cache']).toBe('MISS')
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(Buffer.compare(hit.rawPayload, bytes)).toBe(0)
    expect(hit.headers['content-type']).toBe('application/octet-stream')
    expect(stored.map(event => event.bytes)).toEqual([bytes.length])
  })

  // A second install on one context would give every cached route two read hooks and two store hooks over one
  // set of request decorations, each install overwriting the other's per-request state.
  it('refuses a second registration on the same server', async () => {
    const deps = { store: new MemoryHTTPCacheStore(), etagGenerator: undefined, statusHeader: 'X-Cache' }
    const server = fastify()
    close = () => server.close()
    void server.register(cachePlugin(deps))
    void server.register(cachePlugin(deps))

    await expect(server.ready()).rejects.toMatchObject({ code: 'FST_ERR_DEC_ALREADY_PRESENT' })
  })

  it('evicts after a mutation with nobody observing', async () => {
    let calls = 0
    const server = fastify()
    close = () => server.close()
    await server.register(
      cachePlugin({ store: new MemoryHTTPCacheStore(), etagGenerator: undefined, statusHeader: 'X-Cache' }),
    )
    server.route({
      method: 'GET',
      url: '/item',
      config: { cache: { ttl: 60 * Second, tags: ['item'] } },
      handler: () => ({ n: ++calls }),
    })
    server.route({
      method: 'PUT',
      url: '/item',
      config: { cacheInvalidate: { tags: ['item'] } },
      handler: () => ({ ok: true }),
    })
    await server.ready()

    await server.inject('/item')
    expect((await server.inject('/item')).headers['x-cache']).toBe('HIT')

    await server.inject({ method: 'PUT', url: '/item' })

    expect((await server.inject('/item')).json()).toEqual({ n: 2 })
  })
})
