import { Attachment, Controller, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching, type CacheBypassEvent, type CacheMissEvent, type CacheObserver } from '../index.js'

/**
 * A cached route that serves downloads in ranges. A part of a body answers one request only and is never kept; a
 * stored whole body never stands in for the part a resuming client asked for.
 */

const REPORT = Uint8Array.from({ length: 4096 }, (_, i) => i % 251)
const ETAG = '"report-v1"'

@Controller('/cached-downloads')
class CachedDownloadsController {
  @CacheControl({ ttl: 60 * Second })
  @Get('/bytes')
  bytes() {
    return Attachment(REPORT, { name: 'report.bin', etag: ETAG })
  }

  @CacheControl({ ttl: 60 * Second })
  @Get('/blob')
  blob() {
    return Attachment(new Blob([REPORT]), { name: 'report.bin', etag: ETAG })
  }

  // A route that asked for parts to be kept: a part is still never stored under the whole's key.
  @CacheControl({ ttl: 60 * Second, statusCodes: [200, 206] })
  @Get('/parts-listed')
  partsListed() {
    return Attachment(REPORT, { name: 'report.bin', etag: ETAG })
  }

  @CacheControl({ ttl: 60 * Second })
  @Get('/own-policy')
  ownPolicy() {
    return new Response('fresh', { headers: { 'cache-control': 'no-store' } })
  }
}

void [CachedDownloadsController]

describe('a cached route that serves ranges', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start(observer?: CacheObserver) {
    const app = createWebApplication().with(
      HTTPCaching(b => {
        b.store(new MemoryHTTPCacheStore())
        if (observer !== undefined) {
          b.observer(observer)
        }
      }),
    )
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  async function bytesOf(res: Response): Promise<Uint8Array> {
    return new Uint8Array(await res.arrayBuffer())
  }

  it('serves a range of a body it holds whole from the handler, not as the whole it holds', async () => {
    const app = await start()

    const first = await app.fetch('/cached-downloads/bytes')
    expect(first.headers.get('x-cache')).toBe('MISS')

    const second = await app.fetch('/cached-downloads/bytes')
    expect(second.headers.get('x-cache')).toBe('HIT')
    expect(await bytesOf(second)).toEqual(REPORT)

    const part = await app.fetch('/cached-downloads/bytes', { headers: { range: 'bytes=0-99', 'if-range': ETAG } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 0-99/4096')
    expect(part.headers.get('x-cache')).toBe('BYPASS')
    expect(await bytesOf(part)).toEqual(REPORT.slice(0, 100))
  })

  it('never replays a part as the whole: the next full request gets every byte', async () => {
    const app = await start()

    const part = await app.fetch('/cached-downloads/bytes', { headers: { range: 'bytes=0-99' } })
    expect(part.status).toBe(206)

    for (let i = 0; i < 2; i++) {
      const whole = await app.fetch('/cached-downloads/bytes')

      expect(whole.status).toBe(200)
      expect(whole.headers.get('content-range')).toBeNull()
      expect(await bytesOf(whole)).toEqual(REPORT)
    }
  })

  it('never stores a part, even on a route that lists 206 among the statuses it keeps', async () => {
    const app = await start()

    const part = await app.fetch('/cached-downloads/parts-listed', { headers: { range: 'bytes=0-99' } })
    expect(part.status).toBe(206)

    const whole = await app.fetch('/cached-downloads/parts-listed')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('x-cache')).toBe('MISS')
    expect(await bytesOf(whole)).toEqual(REPORT)
  })

  // A Blob goes out as a stream, which the cache does not keep: holding one would read the whole of it into memory.
  it('keeps no Blob it streamed, so a second full request is a miss again', async () => {
    const app = await start()

    await (await app.fetch('/cached-downloads/blob')).arrayBuffer()
    const second = await app.fetch('/cached-downloads/blob')

    expect(second.headers.get('x-cache')).toBe('MISS')
    expect(await bytesOf(second)).toEqual(REPORT)
  })

  it('tells the observer a range request went past the store', async () => {
    const bypasses: CacheBypassEvent[] = []
    const app = await start({ onBypass: event => void bypasses.push(event) })

    await app.fetch('/cached-downloads/bytes', { headers: { range: 'bytes=0-99' } })

    expect(bypasses.map(event => event.reason)).toEqual(['range'])
  })

  it("keeps the handler's ETag on a part, so a client can resume against it", async () => {
    const app = await start()

    const part = await app.fetch('/cached-downloads/blob', { headers: { range: 'bytes=100-199' } })

    expect(part.status).toBe(206)
    expect(part.headers.get('etag')).toBe(ETAG)
  })

  it("answers 304 to a client revalidating a download it holds whole, against the handler's ETag", async () => {
    const app = await start()

    const res = await app.fetch('/cached-downloads/blob', { headers: { 'if-none-match': ETAG } })

    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
  })

  // Answered 304 by the handler, the first request would leave nothing stored, and every client revalidating after
  // it would run the handler again.
  it('fills the store from a revalidation that reaches it first, and answers that one 304 under the route policy', async () => {
    const app = await start()

    const revalidated = await app.fetch('/cached-downloads/bytes', { headers: { 'if-none-match': ETAG } })
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('x-cache')).toBe('MISS')
    expect(revalidated.headers.get('cache-control')).toContain('max-age=60')
    expect(await revalidated.text()).toBe('')

    const next = await app.fetch('/cached-downloads/bytes')
    expect(next.headers.get('x-cache')).toBe('HIT')
    expect(await bytesOf(next)).toEqual(REPORT)
  })

  it('answers a range asked of the store alone (only-if-cached) with the whole it holds, or 504 when it holds none', async () => {
    const app = await start()
    const headers = { range: 'bytes=0-99', 'cache-control': 'only-if-cached' }

    const cold = await app.fetch('/cached-downloads/bytes', { headers })
    expect(cold.status).toBe(504)

    await (await app.fetch('/cached-downloads/bytes')).arrayBuffer()
    const warm = await app.fetch('/cached-downloads/bytes', { headers })
    expect(warm.status).toBe(200)
    expect(warm.headers.get('x-cache')).toBe('HIT')
    expect(await bytesOf(warm)).toEqual(REPORT)
  })

  it('sends several ranges past the store as one multipart answer, and keeps none of it', async () => {
    const app = await start()

    const parts = await app.fetch('/cached-downloads/bytes', { headers: { range: 'bytes=0-9,100-109' } })
    expect(parts.status).toBe(206)
    expect(parts.headers.get('content-type')).toMatch(/^multipart\/byteranges; boundary=/)
    expect(parts.headers.get('x-cache')).toBe('BYPASS')
    await parts.arrayBuffer()

    const whole = await app.fetch('/cached-downloads/bytes')
    expect(whole.headers.get('x-cache')).toBe('MISS')
    expect(await bytesOf(whole)).toEqual(REPORT)
  })

  // RFC 9111 §4.3.2: If-Match and If-Unmodified-Since are not a cache's to evaluate. Answered from the store, a
  // stale precondition would get the stored 200 instead of the handler's 412.
  it('takes a request carrying a precondition past the store, so a stale one is refused even while it holds the content', async () => {
    const bypasses: CacheBypassEvent[] = []
    const app = await start({ onBypass: event => void bypasses.push(event) })
    await (await app.fetch('/cached-downloads/bytes')).arrayBuffer()
    expect((await app.fetch('/cached-downloads/bytes')).headers.get('x-cache')).toBe('HIT')

    const stale = await app.fetch('/cached-downloads/bytes', { headers: { 'if-match': '"report-v0"' } })
    expect(stale.status).toBe(412)
    expect(stale.headers.get('x-cache')).toBe('BYPASS')

    const current = await app.fetch('/cached-downloads/bytes', { headers: { 'if-match': ETAG } })
    expect(current.status).toBe(200)
    expect(await bytesOf(current)).toEqual(REPORT)

    const unmodified = await app.fetch('/cached-downloads/bytes', {
      headers: { 'if-unmodified-since': new Date().toUTCString() },
    })
    expect(unmodified.headers.get('x-cache')).toBe('BYPASS')

    expect(bypasses.map(event => event.reason)).toEqual(['precondition', 'precondition', 'precondition'])
  })

  // RFC 9111 §4.3.2: a cache does not evaluate If-Match or If-Unmodified-Since, and under only-if-cached (§5.2.1.7) it
  // never reaches the handler that does. No stored answer is consistent with a precondition nobody evaluates.
  it('answers 504 to a precondition asked of the store alone, whether it holds the content or not', async () => {
    const misses: CacheMissEvent[] = []
    const app = await start({ onMiss: event => void misses.push(event) })
    const storeAlone = (headers: Record<string, string>) =>
      app.fetch('/cached-downloads/bytes', { headers: { ...headers, 'cache-control': 'only-if-cached' } })

    expect((await storeAlone({ 'if-match': ETAG })).status).toBe(504)

    await (await app.fetch('/cached-downloads/bytes')).arrayBuffer()
    expect((await storeAlone({})).headers.get('x-cache')).toBe('HIT')

    const preconditions: Array<Record<string, string>> = [
      { 'if-match': ETAG },
      { 'if-match': '"report-v0"' },
      { 'if-unmodified-since': new Date().toUTCString() },
    ]
    for (const headers of preconditions) {
      const res = await storeAlone(headers)

      expect(res.status).toBe(504)
      expect(await res.text()).toBe('')
    }

    expect(misses.filter(event => event.reason === 'only-if-cached')).toHaveLength(4)
  })

  it('stores nothing from a request it refused with 412', async () => {
    const app = await start()

    expect((await app.fetch('/cached-downloads/bytes', { headers: { 'if-match': '"report-v0"' } })).status).toBe(412)

    const whole = await app.fetch('/cached-downloads/bytes')
    expect(whole.headers.get('x-cache')).toBe('MISS')
    expect(await bytesOf(whole)).toEqual(REPORT)
  })

  it("sends the Cache-Control a returned Response carries rather than the route's", async () => {
    const app = await start()

    const res = await app.fetch('/cached-downloads/own-policy')

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('fresh')
  })
})
