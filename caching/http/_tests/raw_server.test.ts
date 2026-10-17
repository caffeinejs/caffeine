import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { cachePlugin, type CacheStoreEvent } from '../index.js'

/**
 * `cachePlugin` is a plain server plugin: given its dependencies it runs on a server no application drives, with
 * routes that declare caching in their `config`. No observer is required there, and none is assumed.
 */
describe('cachePlugin on a server the application does not drive', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
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
      config: { cache: { ttl: 60 } },
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
      config: { cache: { ttl: 60, tags: ['item'] } },
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
