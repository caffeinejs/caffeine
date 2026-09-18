import {
  Controller,
  ErrConfiguration,
  Get,
  Post,
  Router,
  createWebApplication,
  fastifyAdapterFactory,
} from '@caffeinejs/http'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryCache } from '../../store/memory/index.js'
import { CacheControl, CacheInvalidate, HTTPCaching, cacheInvalidate } from '../index.js'

/**
 * Invalidation has to delete the key the cache hooks actually stored. Each case below targets an entry whose
 * stored key is not the bare, encoded path — a reordered query, a varying route, a custom key — and fails if
 * the eviction only reports success.
 */
describe('@CacheInvalidate reaches the entries the cache stored', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start() {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).with(
      HTTPCaching(b => b.store(new MemoryCache())),
    )
    close = () => app.close()
    await app.ready()
    return app
  }

  it('evicts a path whose query arrives in a different order than it was stored', async () => {
    let count = 0

    @Controller('/inv-query-paths')
    class QueryPathsController {
      @CacheControl({ ttl: 60 })
      @Get('/items')
      items() {
        return { count: ++count }
      }

      @CacheInvalidate({ paths: ['/inv-query-paths/items?b=2&a=1'] })
      @Post('/mutate')
      mutate() {
        return { ok: true }
      }
    }
    void [QueryPathsController]

    const app = await start()

    await app.fetch('/inv-query-paths/items?a=1&b=2')
    await app.fetch('/inv-query-paths/items?a=1&b=2')
    expect(count).toBe(1)

    await app.fetch('/inv-query-paths/mutate', { method: 'POST' })

    await app.fetch('/inv-query-paths/items?a=1&b=2')
    expect(count).toBe(2)
  })

  it('evicts the request URL, canonicalized, when no paths are given', async () => {
    let count = 0

    @Controller('/inv-query-self')
    class QuerySelfController {
      @CacheControl({ ttl: 60 })
      @Get('/resource')
      get() {
        return { count: ++count }
      }

      @CacheInvalidate()
      @Post('/resource')
      create() {
        return { ok: true }
      }
    }
    void [QuerySelfController]

    const app = await start()

    await app.fetch('/inv-query-self/resource?a=1&b=2')
    expect(count).toBe(1)

    await app.fetch('/inv-query-self/resource?b=2&a=1', { method: 'POST' })

    await app.fetch('/inv-query-self/resource?a=1&b=2')
    expect(count).toBe(2)
  })

  it('clears every Vary variant of a segment, and nothing outside it', async () => {
    let varied = 0
    let elsewhere = 0

    @Controller('/inv-clear')
    class ClearController {
      @CacheControl({ ttl: 60, vary: ['Accept-Language'], segment: 'products' })
      @Get('/products')
      products() {
        return { count: ++varied }
      }

      @CacheControl({ ttl: 60, segment: 'other' })
      @Get('/other')
      other() {
        return { count: ++elsewhere }
      }

      @CacheInvalidate({ segment: 'products', clear: true })
      @Post('/products')
      update() {
        return { ok: true }
      }
    }
    void [ClearController]

    const app = await start()
    const en = { headers: { 'accept-language': 'en' } }
    const pt = { headers: { 'accept-language': 'pt' } }

    await app.fetch('/inv-clear/products', en)
    await app.fetch('/inv-clear/products', pt)
    await app.fetch('/inv-clear/other')
    expect(varied).toBe(2)
    expect(elsewhere).toBe(1)

    await app.fetch('/inv-clear/products', { method: 'POST' })

    await app.fetch('/inv-clear/products', en)
    await app.fetch('/inv-clear/products', pt)
    await app.fetch('/inv-clear/other')
    expect(varied).toBe(4)
    expect(elsewhere).toBe(1)
  })

  it('evicts the key a custom key function produced, and leaves the other entries alone', async () => {
    let count = 0

    @Controller('/inv-key')
    class KeyController {
      @CacheControl({ ttl: 60, key: req => `pet:${req.param('id')}` })
      @Get('/pets/:id')
      find() {
        return { count: ++count }
      }

      @CacheInvalidate({ key: req => `pet:${req.param('id')}` })
      @Post('/pets/:id')
      update() {
        return { ok: true }
      }
    }
    void [KeyController]

    const app = await start()

    await app.fetch('/inv-key/pets/1')
    await app.fetch('/inv-key/pets/2')
    expect(count).toBe(2)

    await app.fetch('/inv-key/pets/1', { method: 'POST' })

    await app.fetch('/inv-key/pets/1')
    await app.fetch('/inv-key/pets/2')
    expect(count).toBe(3)
  })

  it('evicts every key a custom key function returns', async () => {
    let count = 0

    @Controller('/inv-keys')
    class KeysController {
      @CacheControl({ ttl: 60, key: req => `pet:${req.param('id')}` })
      @Get('/pets/:id')
      find() {
        return { count: ++count }
      }

      @CacheInvalidate({ key: () => ['pet:1', 'pet:2'] })
      @Post('/pets')
      bulk() {
        return { ok: true }
      }
    }
    void [KeysController]

    const app = await start()

    await app.fetch('/inv-keys/pets/1')
    await app.fetch('/inv-keys/pets/2')
    expect(count).toBe(2)

    await app.fetch('/inv-keys/pets', { method: 'POST' })

    await app.fetch('/inv-keys/pets/1')
    await app.fetch('/inv-keys/pets/2')
    expect(count).toBe(4)
  })
})

// Declared on a Router mounted by one application, never as a @Controller: a controller registers globally, so
// one built to fail start-up would fail every application created after it in this file.
describe('cacheInvalidate refuses an ambiguous or unbounded eviction at start-up', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  function ready(router: Router) {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(HTTPCaching(b => b.store(new MemoryCache())))
      .mount(router)
    close = () => app.close()
    return app.ready()
  }

  // Without a segment, `clear` would empty the whole store — every route's entries, not the ones this
  // route mutates.
  it('refuses clear without a segment', async () => {
    const router = new Router('/inv-bad-clear')
    router
      .post('/x')
      // @ts-expect-error clear requires a segment
      .with(cacheInvalidate({ clear: true }))
      .handler(() => ({ ok: true }))

    const failure = ready(router)

    await expect(failure).rejects.toThrow(ErrConfiguration)
    await expect(failure).rejects.toThrow(
      'Cannot install cache invalidation on "POST /inv-bad-clear/x": clear requires a segment',
    )
  })

  it('refuses paths and key together', async () => {
    const router = new Router('/inv-bad-paths-key')
    router
      .post('/x')
      // @ts-expect-error paths and key are mutually exclusive
      .with(cacheInvalidate({ paths: ['/a'], key: () => 'a' }))
      .handler(() => ({ ok: true }))

    await expect(ready(router)).rejects.toThrow(
      'Cannot install cache invalidation on "POST /inv-bad-paths-key/x": paths, key and clear are mutually exclusive',
    )
  })

  it('refuses clear together with paths', async () => {
    const router = new Router('/inv-bad-clear-paths')
    router
      .post('/x')
      // @ts-expect-error clear and paths are mutually exclusive
      .with(cacheInvalidate({ clear: true, segment: 'products', paths: ['/a'] }))
      .handler(() => ({ ok: true }))

    await expect(ready(router)).rejects.toThrow(
      'Cannot install cache invalidation on "POST /inv-bad-clear-paths/x": paths, key and clear are mutually exclusive',
    )
  })
})
