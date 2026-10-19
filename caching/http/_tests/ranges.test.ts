import { Attachment, Controller, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching } from '../index.js'

/**
 * A cached route that serves downloads in ranges: a part of a body is an answer to one request only, and must never
 * become what the cache hands the next client as the whole.
 */

const REPORT = Uint8Array.from({ length: 4096 }, (_, i) => i % 251)
const ETAG = '"report-v1"'

@Controller('/cached-downloads')
class CachedDownloadsController {
  @CacheControl({ ttl: 60 })
  @Get('/bytes')
  bytes() {
    return Attachment(REPORT, { name: 'report.bin', etag: ETAG })
  }

  @CacheControl({ ttl: 60 })
  @Get('/blob')
  blob() {
    return Attachment(new Blob([REPORT]), { name: 'report.bin', etag: ETAG })
  }

  @CacheControl({ ttl: 60 })
  @Get('/own-policy')
  ownPolicy() {
    return new Response('fresh', { headers: { 'cache-control': 'no-store' } })
  }
}

void [CachedDownloadsController]

describe('a cached route that serves ranges', () => {
  const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each(['bytes', 'blob'])(
    'never replays a part of a %s body as the whole: the next full request gets every byte',
    async kind => {
      const part = await app.fetch(`/cached-downloads/${kind}`, { headers: { range: 'bytes=0-99' } })
      expect(part.status).toBe(206)
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(REPORT.slice(0, 100))

      for (let i = 0; i < 2; i++) {
        const whole = await app.fetch(`/cached-downloads/${kind}`)

        expect(whole.status).toBe(200)
        expect(whole.headers.get('content-range')).toBeNull()
        expect(new Uint8Array(await whole.arrayBuffer())).toEqual(REPORT)
      }
    },
  )

  it("keeps the handler's ETag on a part, so a client can resume against it", async () => {
    const part = await app.fetch('/cached-downloads/blob', { headers: { range: 'bytes=100-199' } })

    expect(part.status).toBe(206)
    expect(part.headers.get('etag')).toBe(ETAG)
  })

  it("answers 304 to a client revalidating a download it holds whole, against the handler's ETag", async () => {
    const res = await app.fetch('/cached-downloads/blob', { headers: { 'if-none-match': ETAG } })

    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
  })

  it("sends the Cache-Control a returned Response carries rather than the route's", async () => {
    const res = await app.fetch('/cached-downloads/own-policy')

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('fresh')
  })
})
