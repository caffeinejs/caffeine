import { Controller, Get, Header, Post, Principal, Status, createWebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryCache } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching, type CacheBypassEvent, type CacheObserver } from '../index.js'

/**
 * What a client, or a cache between it and the server, is told about a response — and what a hit replays. Each
 * case is a response the cache used to mislabel or misreport.
 */
describe('what the cache says about a response', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // A negative answer is cacheable when the route says so, and it stays the answer it was.
  it('replays a stored 404 as a 404', async () => {
    @Controller('/resp-status')
    class StatusController {
      @CacheControl({ ttl: 60, statusCodes: [200, 404] })
      @Status(404)
      @Get('/missing')
      missing() {
        return { error: 'nope' }
      }
    }
    void [StatusController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const miss = await app.fetch('/resp-status/missing')
    const hit = await app.fetch('/resp-status/missing')

    expect(miss.status).toBe(404)
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.status).toBe(404)

    // RFC 9110 §13.2.1: a precondition is ignored where the answer is not a 2xx.
    const conditional = await app.fetch('/resp-status/missing', {
      headers: { 'if-none-match': hit.headers.get('etag') ?? '*' },
    })
    expect(conditional.status).toBe(404)
  })

  // An error marked `public, max-age=60` is an error a CDN keeps serving after the fault is fixed.
  it('says nothing permissive about a response the route does not cache', async () => {
    @Controller('/resp-noncacheable')
    @CacheControl({ ttl: 60 })
    class NonCacheableController {
      @Get('/boom')
      boom() {
        throw new Error('boom')
      }

      @Post('/create')
      create() {
        return { created: true }
      }

      @Get('/ok')
      ok() {
        return { ok: true }
      }
    }
    void [NonCacheableController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const failed = await app.fetch('/resp-noncacheable/boom')
    expect(failed.status).toBe(500)
    expect(failed.headers.get('cache-control')).toBeNull()
    expect(failed.headers.get('etag')).toBeNull()

    const gateway = await app.fetch('/resp-noncacheable/ok', { headers: { 'cache-control': 'only-if-cached' } })
    expect(gateway.status).toBe(504)
    expect(gateway.headers.get('cache-control')).toBeNull()

    expect((await app.fetch('/resp-noncacheable/create', { method: 'POST' })).headers.get('cache-control')).toBeNull()
    expect((await app.fetch('/resp-noncacheable/ok')).headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('keeps no-store on the error of a route that stores nothing', async () => {
    @Controller('/resp-nostore')
    class NoStoreController {
      @CacheControl({ noStore: true })
      @Get('/boom')
      boom() {
        throw new Error('boom')
      }
    }
    void [NoStoreController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const failed = await app.fetch('/resp-nostore/boom')

    expect(failed.status).toBe(500)
    expect(failed.headers.get('cache-control')).toBe('no-store')
  })

  // The handler knows this response is one client's. The route's policy does not get to publish it.
  it('leaves a Cache-Control the handler wrote as written, and does not store that response', async () => {
    let calls = 0

    @Controller('/resp-handler-cc')
    class HandlerDecidesController {
      @CacheControl({ ttl: 60 })
      @Header('Cache-Control', 'private, no-store')
      @Get('/secret')
      secret() {
        return { n: ++calls }
      }
    }
    void [HandlerDecidesController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const first = await app.fetch('/resp-handler-cc/secret')
    const second = await app.fetch('/resp-handler-cc/secret')

    expect(first.headers.get('cache-control')).toBe('private, no-store')
    expect(second.headers.get('x-cache')).toBe('MISS')
    expect(await second.json()).toEqual({ n: 2 })
  })

  it('keeps the validators the handler set, stores them, and revalidates against them', async () => {
    @Controller('/resp-handler-validators')
    class HandlerValidatorsController {
      @CacheControl({ ttl: 60 })
      @Header('ETag', '"v42"')
      @Header('Last-Modified', 'Mon, 01 Jan 2024 00:00:00 GMT')
      @Get('/doc')
      doc() {
        return { version: 42 }
      }
    }
    void [HandlerValidatorsController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const miss = await app.fetch('/resp-handler-validators/doc')
    expect(miss.headers.get('etag')).toBe('"v42"')
    expect(miss.headers.get('last-modified')).toBe('Mon, 01 Jan 2024 00:00:00 GMT')

    const hit = await app.fetch('/resp-handler-validators/doc')
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('etag')).toBe('"v42"')

    const revalidated = await app.fetch('/resp-handler-validators/doc', { headers: { 'if-none-match': '"v42"' } })
    expect(revalidated.status).toBe(304)
  })

  // A hit is the response the handler produced, not an abridged one: pagination totals, a language, a filename.
  it('replays the headers of the stored response, and never its cookies', async () => {
    @Controller('/resp-headers')
    class HeadersController {
      @CacheControl({ ttl: 60 })
      @Header('X-Total-Count', '42')
      @Header('Content-Language', 'en')
      @Header('Set-Cookie', 'visit=1')
      @Get('/list')
      list() {
        return [1, 2, 3]
      }
    }
    void [HeadersController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const miss = await app.fetch('/resp-headers/list')
    expect(miss.headers.get('set-cookie')).toBe('visit=1')

    const hit = await app.fetch('/resp-headers/list')
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('x-total-count')).toBe('42')
    expect(hit.headers.get('content-language')).toBe('en')
    expect(hit.headers.get('content-type')).toBe(miss.headers.get('content-type'))
    expect(hit.headers.get('set-cookie')).toBeNull()
  })

  // CORS answers each request for its own origin: what it set for this one outranks what was stored with another.
  it('does not replace a header an earlier hook set for this request, and merges Vary', async () => {
    @Controller('/resp-vary')
    class VaryController {
      @CacheControl({ ttl: 60, vary: ['Accept-Language'] })
      @Get('/page')
      page() {
        return { ok: true }
      }
    }
    void [VaryController]

    const app = createWebApplication()
      .server(undefined, server => {
        server.addHook('onRequest', async (request, reply) => {
          reply.header('Vary', 'Origin')
          reply.header('Access-Control-Allow-Origin', String(request.headers.origin))
        })
      })
      .with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const miss = await app.fetch('/resp-vary/page', { headers: { origin: 'https://a.example' } })
    expect(miss.headers.get('vary')).toBe('Origin, Accept-Language')

    const hit = await app.fetch('/resp-vary/page', { headers: { origin: 'https://b.example' } })
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('vary')).toBe('Origin, Accept-Language')
    expect(hit.headers.get('access-control-allow-origin')).toBe('https://b.example')
  })

  // RFC 9110 §8.6: a HEAD may carry Content-Length only if it is the one the GET would carry.
  it('gives a HEAD hit the Content-Length of the GET, and no body', async () => {
    @Controller('/resp-head')
    class HeadController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { value: 'x'.repeat(100) }
      }
    }
    void [HeadController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const get = await app.fetch('/resp-head/data')
    const head = await app.fetch('/resp-head/data', { method: 'HEAD' })

    expect(head.headers.get('x-cache')).toBe('HIT')
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(100)
    expect(await head.text()).toBe('')
  })

  // RFC 9110 §15.4.5: a 304 carries what guides a cache update, not the representation's other metadata.
  it('answers a revalidation with the validators and the policy, not the content type', async () => {
    @Controller('/resp-304')
    class NotModifiedController {
      @CacheControl({ ttl: 60, vary: ['Accept-Language'] })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [NotModifiedController]

    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache())))
    close = () => app.close()
    await app.ready()

    const etag = (await app.fetch('/resp-304/data')).headers.get('etag') as string
    const res = await app.fetch('/resp-304/data', { headers: { 'if-none-match': etag } })

    expect(res.status).toBe(304)
    expect(res.headers.get('x-cache')).toBe('HIT')
    expect(res.headers.get('etag')).toBe(etag)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('vary')).toBe('Accept-Language')
    expect(res.headers.get('content-type')).toBeNull()
  })
})

/**
 * A response to an identified client is that client's, whatever proved the identity. The cache used to look for
 * the `Authorization` header alone, so a session cookie's response was stored and handed to everyone.
 */
describe('a request authenticated without an Authorization header', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  function signedIn(observer?: CacheObserver) {
    return createWebApplication()
      .server(undefined, server => {
        server.addHook('onRequest', async request => {
          if (request.headers.cookie?.includes('session=')) {
            request.user = new Principal(true, [])
          }
        })
      })
      .with(HTTPCaching(b => (observer ? b.store(new MemoryCache()).observer(observer) : b.store(new MemoryCache()))))
  }

  it('is answered privately, is not stored, and is not served what someone else stored', async () => {
    let calls = 0
    const bypasses: CacheBypassEvent[] = []

    @Controller('/auth-private')
    class PrivateController {
      @CacheControl({ ttl: 60 })
      @Get('/me')
      me() {
        return { n: ++calls }
      }
    }
    void [PrivateController]

    const app = signedIn({ onBypass: event => bypasses.push(event) })
    close = () => app.close()
    await app.ready()

    const alice = await app.fetch('/auth-private/me', { headers: { cookie: 'session=alice' } })
    expect(alice.headers.get('cache-control')).toBe('private, max-age=60')
    expect(alice.headers.get('x-cache')).toBe('BYPASS')

    const bob = await app.fetch('/auth-private/me', { headers: { cookie: 'session=bob' } })
    expect(await bob.json()).toEqual({ n: 2 })

    // Nothing of theirs reached the store: an anonymous request misses.
    const anonymous = await app.fetch('/auth-private/me')
    expect(anonymous.headers.get('x-cache')).toBe('MISS')
    expect(bypasses.map(event => event.reason)).toEqual(['authenticated', 'authenticated'])
  })

  it('is cached like any other on a route that declares itself public', async () => {
    let calls = 0

    @Controller('/auth-public')
    class PublicController {
      @CacheControl({ ttl: 60, privacy: 'public' })
      @Get('/catalog')
      catalog() {
        return { n: ++calls }
      }
    }
    void [PublicController]

    const app = signedIn()
    close = () => app.close()
    await app.ready()

    await app.fetch('/auth-public/catalog', { headers: { cookie: 'session=alice' } })
    const second = await app.fetch('/auth-public/catalog', { headers: { cookie: 'session=bob' } })

    expect(second.headers.get('x-cache')).toBe('HIT')
    expect(calls).toBe(1)
  })
})
