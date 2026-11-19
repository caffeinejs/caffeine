import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { HTTPCaching, cacheControl } from '@caffeinejs/caching/http'
import { MemoryHTTPCacheStore } from '@caffeinejs/caching/store/memory'
import { CaffeineIoC } from '@caffeinejs/di'
import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { compression } from '@caffeinejs/http/compress'
import { Minute } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `HTTPCaching` and `compression()` over the same route. The cache must store identity bytes and the compressor code
 * each answer on its way out, hit or miss; that holds only when caching runs first.
 */

const REPORT = { rows: Array.from({ length: 100 }, (_, i) => ({ i, text: `row ${i} of the cached report` })) }
const JSON_TEXT = JSON.stringify(REPORT)

let close: (() => Promise<unknown>) | undefined

afterEach(async () => {
  vi.useRealTimers()
  await close?.()
  close = undefined
})

function report(): Router<any, any, any, any, any> {
  let runs = 0
  const router = new Router('/report')
  router
    .get('/')
    .extend(cacheControl({ ttl: 10 * Minute }))
    .handler(ctx => {
      runs++
      ctx.header('x-runs', String(runs))
      return REPORT
    })
  return router
}

// Programmatic routes on a container that reads no decorators: a controller another test declared is not routed here.
const newApp = () => createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })

describe('HTTPCaching registered before compression() in one slot', () => {
  async function start() {
    const app = newApp()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .with(compression())
      .mount(report())
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  it('stores identity bytes, and codes each answer for the client asking, hit or miss', async () => {
    const app = await start()

    const gzip = await app.request('/report', { headers: { 'accept-encoding': 'gzip' } })
    const identity = await app.request('/report')
    const br = await app.request('/report', { headers: { 'accept-encoding': 'br' } })

    expect(gzip.headers.get('x-cache')).toBe('MISS')
    expect(gzip.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(JSON_TEXT)

    expect(identity.headers.get('x-cache')).toBe('HIT')
    expect(identity.headers.get('content-encoding')).toBe(null)
    expect(await identity.text()).toBe(JSON_TEXT)

    expect(br.headers.get('x-cache')).toBe('HIT')
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(JSON_TEXT)
    expect(br.headers.get('x-runs')).toBe('1')
  })

  it('answers a client that refuses identity from the identity entry, coded on the way out', async () => {
    const app = await start()

    await app.request('/report')
    const refused = await app.request('/report', { headers: { 'accept-encoding': 'gzip, identity;q=0' } })

    expect(refused.headers.get('x-cache')).toBe('HIT')
    expect(refused.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await refused.arrayBuffer())).toString()).toBe(JSON_TEXT)
  })

  it('varies a hit on Accept-Encoding, and sends the stored tag on a compressed hit and on its 304', async () => {
    const app = await start()

    const identity = await app.request('/report')
    const hit = await app.request('/report', { headers: { 'accept-encoding': 'gzip' } })
    const etag = identity.headers.get('etag')!
    const revalidated = await app.request('/report', {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': etag },
    })

    expect(etag.startsWith('"')).toBe(true)
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('content-encoding')).toBe('gzip')
    expect(hit.headers.get('vary')).toBe('Accept-Encoding')
    expect(hit.headers.get('etag')).toBe(etag)
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('etag')).toBe(etag)
  })
})

// Not refused at start-up: the compressor on the server runs before a cache on a router, whatever the order written.
describe('compression() on the server with HTTPCaching on a router, the order its documentation warns against', () => {
  it('stores nothing compression coded, so a client asking for identity gets identity', async () => {
    const router = report().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    const app = newApp().with(compression()).mount(router)
    close = () => app.close()
    await app.bootstrap()

    const gzip = await app.request('/report', { headers: { 'accept-encoding': 'gzip' } })
    const identity = await app.request('/report', { headers: { 'accept-encoding': 'identity' } })

    expect(gzip.headers.get('content-encoding')).toBe('gzip')
    expect(gzip.headers.get('x-cache')).toBe('MISS')
    expect(identity.headers.get('x-cache')).toBe('MISS')
    expect(identity.headers.get('content-encoding')).toBe(null)
    expect(await identity.text()).toBe(JSON_TEXT)
  })

  it('answers a 5xx compression coded with the stale identity entry, labelled as identity', async () => {
    let failing = false
    const router = new Router('/flaky')
    router
      .get('/')
      .extend(cacheControl({ ttl: 1 * Minute, staleIfError: 5 * Minute }))
      .handler(ctx => {
        if (failing) {
          ctx.status(503).header('content-type', 'text/plain')
          return 'down '.repeat(1000)
        }
        return REPORT
      })
    const app = newApp()
      .with(compression())
      .mount(router.with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore()))))
    close = () => app.close()
    await app.bootstrap()
    vi.useFakeTimers({ toFake: ['Date'] })

    const stored = await app.request('/flaky', { headers: { 'accept-encoding': 'identity' } })
    vi.setSystemTime(Date.now() + 2 * Minute)
    failing = true
    const rescued = await app.request('/flaky', { headers: { 'accept-encoding': 'gzip' } })

    expect(stored.headers.get('x-cache')).toBe('MISS')
    expect(rescued.status).toBe(200)
    expect(rescued.headers.get('x-cache')).toBe('STALE')
    expect(rescued.headers.get('content-encoding')).toBe(null)
    expect(await rescued.text()).toBe(JSON_TEXT)
  })
})
