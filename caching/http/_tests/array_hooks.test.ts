import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import type { Cache } from '../../store.js'
import { MemoryCache } from '../../store/memory/index.js'
import { cachePlugin } from '../index.js'

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
    const inner = new MemoryCache()
    let gets = 0
    const store: Cache = {
      get: (key, segment) => {
        gets++
        return inner.get(key, segment)
      },
      getMany: (keys, segment) => inner.getMany(keys, segment),
      put: (key, entry, ttl, segment) => inner.put(key, entry, ttl, segment),
      putMany: (items, segment) => inner.putMany(items, segment),
      delete: (key, segment) => inner.delete(key, segment),
      deleteMany: (keys, segment) => inner.deleteMany(keys, segment),
      clear: segment => inner.clear(segment),
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
