import { CaffeineIoC } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/node'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { cachePlugin, type CacheHitEvent, type CacheMissEvent } from '../index.js'

/**
 * The cache adds its hooks to the route beside the ones the route declares itself, and the HEAD route of a GET shares
 * them all.
 */
describe('a route that declares hooks of its own', () => {
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
    const router = new Router('')
    router
      .get('/data')
      .config('cache', { ttl: 60 * Second })
      .hook('onRequest', async () => {})
      .hook('onRequest', async () => {})
      .hook('onSend', async () => {})
      .hook('onSend', async () => {})
      .handler(() => ({ ok: true }))

    const app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .with(() =>
        cachePlugin({
          store: new MemoryHTTPCacheStore(),
          etagGenerator: undefined,
          statusHeader: 'X-Cache',
          observer: { onMiss: event => misses.push(event), onHit: event => hits.push(event) },
        }),
      )
      .mount(router)
    close = () => app.close()
    await app.bootstrap()

    const miss = await app.request('/data')
    expect(miss.headers.get('x-cache')).toBe('MISS')
    expect([misses.length, hits.length]).toEqual([1, 0])

    const head = await app.request('/data', { method: 'HEAD' })
    expect(head.headers.get('x-cache')).toBe('HIT')
    expect([misses.length, hits.length]).toEqual([1, 1])
  })
})
