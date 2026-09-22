import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get, Post, Put, Router, Status, createWebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import {
  CacheControl,
  CacheInvalidate,
  HTTPCaching,
  cacheControl,
  cacheInvalidate,
  kHTTPCacheStore,
  type HTTPCacheStore,
} from '../index.js'

/**
 * Eviction is by tag: a mutating route names the tags it invalidates, and every entry stored under any of them
 * goes, whatever route stored it and whatever its key was. Each case fails if the eviction only reports success.
 */
describe('@CacheInvalidate reaches the entries stored under its tags', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start() {
    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.ready()
    return app
  }

  it('evicts a tagged entry whatever URL and query it was stored under', async () => {
    let count = 0

    @Controller('/inv-tag')
    class TagController {
      @CacheControl({ ttl: 60, tags: ['items'] })
      @Get('/items')
      items() {
        return { count: ++count }
      }

      @CacheInvalidate({ tags: ['items'] })
      @Post('/mutate')
      mutate() {
        return { ok: true }
      }
    }
    void [TagController]

    const app = await start()

    await app.fetch('/inv-tag/items?a=1&b=2')
    await app.fetch('/inv-tag/items?b=2&a=1')
    expect(count).toBe(1)

    await app.fetch('/inv-tag/mutate', { method: 'POST' })

    await app.fetch('/inv-tag/items?a=1&b=2')
    expect(count).toBe(2)
  })

  it('evicts every Vary variant of a route under the tag, and nothing outside it', async () => {
    let varied = 0
    let elsewhere = 0

    @Controller('/inv-variants')
    class VariantsController {
      @CacheControl({ ttl: 60, vary: ['Accept-Language'], tags: ['products'] })
      @Get('/products')
      products() {
        return { count: ++varied }
      }

      @CacheControl({ ttl: 60, tags: ['other'] })
      @Get('/other')
      other() {
        return { count: ++elsewhere }
      }

      @CacheInvalidate({ tags: ['products'] })
      @Post('/products')
      update() {
        return { ok: true }
      }
    }
    void [VariantsController]

    const app = await start()
    const en = { headers: { 'accept-language': 'en' } }
    const pt = { headers: { 'accept-language': 'pt' } }

    await app.fetch('/inv-variants/products', en)
    await app.fetch('/inv-variants/products', pt)
    await app.fetch('/inv-variants/other')
    expect(varied).toBe(2)
    expect(elsewhere).toBe(1)

    await app.fetch('/inv-variants/products', { method: 'POST' })

    await app.fetch('/inv-variants/products', en)
    await app.fetch('/inv-variants/products', pt)
    await app.fetch('/inv-variants/other')
    expect(varied).toBe(4)
    expect(elsewhere).toBe(1)
  })

  it('evicts an entry with several tags by any one of them, and reaches a route with a custom key', async () => {
    let one = 0
    let list = 0

    @Controller('/inv-many')
    class ManyController {
      @CacheControl({ ttl: 60, tags: ['pets', 'catalogue'] })
      @Get('/')
      list() {
        return { list: ++list }
      }

      @CacheControl({ ttl: 60, tags: ['pets'], key: req => `pet:${req.param('id')}` })
      @Get('/:id')
      find() {
        return { one: ++one }
      }

      @CacheInvalidate({ tags: ['catalogue'] })
      @Put('/reorder')
      reorder() {
        return { ok: true }
      }

      @CacheInvalidate({ tags: ['pets'] })
      @Put('/:id')
      update() {
        return { updated: true }
      }
    }
    void [ManyController]

    const app = await start()

    await app.fetch('/inv-many')
    await app.fetch('/inv-many/1')
    expect([list, one]).toEqual([1, 1])

    await app.fetch('/inv-many/reorder', { method: 'PUT' })
    await app.fetch('/inv-many')
    await app.fetch('/inv-many/1')
    expect([list, one]).toEqual([2, 1])

    await app.fetch('/inv-many/1', { method: 'PUT' })
    await app.fetch('/inv-many')
    await app.fetch('/inv-many/1')
    expect([list, one]).toEqual([3, 2])
  })

  // The store is bound under the token so anything can inject it: a consumer of a message, a job, another
  // route. What it evicts is seen by the next request.
  it('is what a service evicting through the bound store does, seen by the next request', async () => {
    let count = 0

    @Controller('/inv-service')
    class ServiceController {
      @CacheControl({ ttl: 60, tags: ['reports'] })
      @Get('/report')
      report() {
        return { count: ++count }
      }
    }
    void [ServiceController]

    const container = new CaffeineIoC()
    container.bind(kHTTPCacheStore, t => t.toValue(new MemoryHTTPCacheStore()))
    const app = createWebApplication({ container }).with(HTTPCaching(b => b.store(kHTTPCacheStore)))
    close = () => app.close()
    await app.ready()

    await app.fetch('/inv-service/report')
    expect((await app.fetch('/inv-service/report')).headers.get('x-cache')).toBe('HIT')

    const store: HTTPCacheStore = app.container.get(kHTTPCacheStore)
    await store.evictByTag('reports')

    expect((await app.fetch('/inv-service/report')).headers.get('x-cache')).toBe('MISS')
    expect(count).toBe(2)
  })
})

/**
 * RFC 9111 §4.4: a non-error response to an unsafe request invalidates, and that is a 2xx **or a 3xx**. A form
 * post answered with a redirect is the commonest mutation there is.
 */
describe('@CacheInvalidate and the status of the mutation', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('evicts when the mutation is answered with a redirect, and not when it failed', async () => {
    let count = 0

    @Controller('/inv-status')
    class StatusController {
      @CacheControl({ ttl: 60, tags: ['items'] })
      @Get('/items')
      items() {
        return { count: ++count }
      }

      @CacheInvalidate({ tags: ['items'] })
      @Status(303)
      @Post('/items')
      create() {
        return ''
      }

      @CacheInvalidate({ tags: ['items'] })
      @Status(409)
      @Post('/conflict')
      conflict() {
        return { error: 'conflict' }
      }
    }
    void [StatusController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    close = () => app.close()
    await app.ready()

    await app.fetch('/inv-status/items')
    expect((await app.fetch('/inv-status/conflict', { method: 'POST' })).status).toBe(409)
    expect((await app.fetch('/inv-status/items')).headers.get('x-cache')).toBe('HIT')

    expect((await app.fetch('/inv-status/items', { method: 'POST', redirect: 'manual' })).status).toBe(303)

    expect(await (await app.fetch('/inv-status/items')).json()).toEqual({ count: 2 })
  })
})

/**
 * The adapter gives every request its context before any route hook runs. A key function is handed that
 * context's request, never one built for it: what it reads, params and validated input included, is what the
 * handler reads, and a request costs no second wrapper.
 */
describe('the request a key function is handed', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it("is the one the handler's context holds", async () => {
    const seen: { by: string; req: unknown }[] = []
    const router = new Router('/key-request')
    router
      .get('/:id')
      .with(
        cacheControl({
          ttl: 60,
          key: req => {
            seen.push({ by: 'cache key', req })
            return `item:${req.param('id')}`
          },
        }),
      )
      .handler(ctx => {
        seen.push({ by: 'get handler', req: ctx.req })
        return { ok: true }
      })

    const app = createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .mount(router)
    close = () => app.close()
    await app.ready()

    await app.fetch('/key-request/1')
    expect(seen.map(item => item.by)).toEqual(['cache key', 'get handler'])
    expect(seen[0].req).toBe(seen[1].req)
  })
})

describe('cacheInvalidate refuses an eviction that names nothing at start-up', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  function ready(router: Router) {
    const app = createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .mount(router)
    close = () => app.close()
    return app.ready()
  }

  it('refuses an empty list of tags', async () => {
    const router = new Router('/inv-bad-empty')
    router
      .post('/x')
      .with(cacheInvalidate({ tags: [] }))
      .handler(() => ({ ok: true }))

    const failure = ready(router)

    await expect(failure).rejects.toThrow(ErrConfiguration)
    await expect(failure).rejects.toThrow(
      'Cannot install cache invalidation on "POST /inv-bad-empty/x": tags must name at least one tag',
    )
  })

  it('refuses a tag that is empty or holds a brace', async () => {
    const router = new Router('/inv-bad-tag')
    router
      .post('/x')
      .with(cacheInvalidate({ tags: ['pets', '{1}'] }))
      .handler(() => ({ ok: true }))

    await expect(ready(router)).rejects.toThrow(
      'Cannot install cache invalidation on "POST /inv-bad-tag/x": a tag must be a non-empty string without "{" or "}", got "{1}"',
    )
  })

  it('refuses options with no tags at all, as a route registered on the server itself may carry', async () => {
    const router = new Router('/inv-bad-none')
    router
      .post('/x')
      .with(cacheInvalidate({} as never))
      .handler(() => ({ ok: true }))

    await expect(ready(router)).rejects.toThrow(
      'Cannot install cache invalidation on "POST /inv-bad-none/x": tags must name at least one tag',
    )
  })
})
