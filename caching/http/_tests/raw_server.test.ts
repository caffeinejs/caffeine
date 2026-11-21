import { Readable } from 'node:stream'

import { CaffeineIoC } from '@caffeinejs/di'
import { Router, type AnyRouter, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { cachePlugin, type CacheObserver, type CacheStoreEvent } from '../index.js'

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
 * `cachePlugin` is a plain plugin: given its dependencies it runs on an application, with routes that declare
 * caching in their `config`. No observer is required there, and none is assumed.
 */
describe('cachePlugin given its dependencies, with nobody observing', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await close?.()
    close = undefined
  })

  const deps = () => ({ store: new MemoryHTTPCacheStore(), etagGenerator: undefined, statusHeader: 'X-Cache' })

  async function serve(route: (router: AnyRouter) => void, observer?: CacheObserver) {
    const router = new Router()
    route(router)
    const app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .with(() => cachePlugin({ ...deps(), observer }))
      .mount(router)
    close = () => app.close()
    await app.bootstrap()

    return app
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
    const app = await serve(r =>
      r
        .get('/file')
        .routeOptions({ cache: { ttl: 60 * Second } })
        .handler(ctx => {
          ctx.header(validator, validator === 'etag' ? '"v1"' : lastModified)
          return streamed.body as never
        }),
    )

    const res = await app.request('/file', {
      headers: validator === 'etag' ? { 'if-none-match': '"v1"' } : { 'if-modified-since': lastModified },
    })

    expect(res.status).toBe(304)
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
      const app = await serve(r =>
        r
          .get('/file')
          .routeOptions({ cache: { ttl: 60 * Second } })
          .handler(ctx => {
            ctx.header('etag', '"v1"')
            return streamed.body as never
          }),
      )

      const res = await app.request('/file', { headers: { 'if-none-match': '"v1"' } })
      await new Promise(resolve => setImmediate(resolve))

      expect(res.status).toBe(304)
      expect(streamed.closed()).toBe(true)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('closes a streamed 5xx it serves a stale entry in place of', async () => {
    let calls = 0
    const streamed = nodeStream()
    const app = await serve(r =>
      r
        .get('/flaky')
        .routeOptions({ cache: { ttl: 60 * Second, staleIfError: 300 * Second } })
        .handler(ctx => {
          if (++calls === 1) {
            return 'fresh'
          }

          ctx.status(503)
          return streamed.body as never
        }),
    )
    vi.useFakeTimers({ toFake: ['Date'] })

    await app.request('/flaky')
    vi.setSystemTime(Date.now() + 100_000)
    const res = await app.request('/flaky')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe('STALE')
    expect(await res.text()).toBe('fresh')
    expect(streamed.closed()).toBe(true)
  })

  // A HEAD carries the length its GET would have had, which for bytes is their count, not a character count.
  it('gives a HEAD served a stale binary entry over a 5xx the length of its bytes', async () => {
    let calls = 0
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])
    const app = await serve(r =>
      r
        .get('/blob')
        .routeOptions({ cache: { ttl: 60 * Second, staleIfError: 300 * Second } })
        .handler(ctx => {
          if (++calls === 1) {
            ctx.header('content-type', 'application/octet-stream')
            return bytes
          }

          ctx.status(503)
          return 'down'
        }),
    )
    vi.useFakeTimers({ toFake: ['Date'] })

    await app.request('/blob')
    vi.setSystemTime(Date.now() + 100_000)
    const res = await app.request('/blob', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache')).toBe('STALE')
    expect(res.headers.get('content-length')).toBe(String(bytes.length))
    expect(await res.text()).toBe('')
  })

  // A binary response is cached as the bytes it is, and its size reported in bytes, not in characters.
  it('stores a Buffer payload and replays it byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])
    const stored: CacheStoreEvent[] = []
    const app = await serve(
      r =>
        r
          .get('/blob')
          .routeOptions({ cache: { ttl: 60 * Second } })
          .handler(ctx => {
            ctx.header('content-type', 'application/octet-stream')
            return bytes
          }),
      { onStore: event => stored.push(event) },
    )

    const miss = await app.request('/blob')
    const hit = await app.request('/blob')

    expect(miss.headers.get('x-cache')).toBe('MISS')
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(Buffer.compare(Buffer.from(await hit.arrayBuffer()), bytes)).toBe(0)
    expect(hit.headers.get('content-type')).toBe('application/octet-stream')
    expect(stored.map(event => event.size)).toEqual([bytes.length])
  })

  // A second install on one context would give every cached route two read hooks and two store hooks, each
  // install overwriting the other's per-request state.
  it('refuses a second registration on the same server', async () => {
    const app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .with(() => cachePlugin(deps()))
      .with(() => cachePlugin(deps()))
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(/Cannot register plugin "@caffeinejs\/caching" twice/)
  })

  it('evicts after a mutation with nobody observing', async () => {
    let calls = 0
    const app = await serve(r => {
      r.get('/item')
        .routeOptions({ cache: { ttl: 60 * Second, tags: ['item'] } })
        .handler(() => ({ n: ++calls }))
      r.put('/item')
        .routeOptions({ cacheInvalidate: { tags: ['item'] } })
        .handler(() => ({ ok: true }))
    })

    await app.request('/item')
    expect((await app.request('/item')).headers.get('x-cache')).toBe('HIT')

    await app.request('/item', { method: 'PUT' })

    expect(await (await app.request('/item')).json()).toEqual({ n: 2 })
  })
})
