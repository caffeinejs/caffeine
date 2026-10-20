import { Second } from '@caffeinejs/std/duration'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { cachePlugin, type CacheHitEvent, type CacheMissEvent } from '../index.js'

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

  // Hooks doubled on the route, or on its HEAD twin, would run the cache twice per request and report every
  // outcome twice.
  it('runs the cache once per request, on the route and on its HEAD twin', async () => {
    const misses: CacheMissEvent[] = []
    const hits: CacheHitEvent[] = []
    const server = fastify()
    close = () => server.close()
    await server.register(
      cachePlugin({
        store: new MemoryHTTPCacheStore(),
        etagGenerator: undefined,
        statusHeader: 'X-Cache',
        observer: { onMiss: event => misses.push(event), onHit: event => hits.push(event) },
      }),
    )
    server.route({
      method: 'GET',
      url: '/data',
      onRequest: [async () => {}, async () => {}],
      onSend: [async (_request, _reply, payload) => payload, async (_request, _reply, payload) => payload],
      config: { cache: { ttl: 60 * Second } },
      handler: () => ({ ok: true }),
    })
    await server.ready()

    const miss = await server.inject('/data')
    expect(miss.headers['x-cache']).toBe('MISS')
    expect([misses.length, hits.length]).toEqual([1, 0])

    const head = await server.inject({ method: 'HEAD', url: '/data' })
    expect(head.headers['x-cache']).toBe('HIT')
    expect([misses.length, hits.length]).toEqual([1, 1])
  })
})
