import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { cachePlugin, type HTTPCacheStore } from '../index.js'

/**
 * Fastify clones a GET route's options shallowly for its automatic HEAD twin, so an array in a hook slot is the
 * same array on both. Hooks pushed onto it would land on both routes, and the twin would add its own on top.
 */
describe('a route that declares its hooks as arrays', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('consults the store once per request', async () => {
    const inner = new MemoryHTTPCacheStore()
    let gets = 0
    const store: HTTPCacheStore = {
      get: (key, options) => {
        gets++
        return inner.get(key, options)
      },
      put: (key, entry, options) => inner.put(key, entry, options),
      evictByTag: (tags, options) => inner.evictByTag(tags, options),
    }

    const server = fastify()
    close = () => server.close()
    await server.register(cachePlugin({ store, etagGenerator: undefined, statusHeader: 'X-Cache' }))
    server.route({
      method: 'GET',
      url: '/data',
      onRequest: [async () => {}, async () => {}],
      onSend: [async (_request, _reply, payload) => payload, async (_request, _reply, payload) => payload],
      config: { cache: { ttl: 60 } },
      handler: () => ({ ok: true }),
    })
    await server.ready()

    const miss = await server.inject('/data')
    expect(miss.headers['x-cache']).toBe('MISS')
    expect(gets).toBe(1)

    const head = await server.inject({ method: 'HEAD', url: '/data' })
    expect(head.headers['x-cache']).toBe('HIT')
    expect(gets).toBe(2)
  })
})
