import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from 'node:zlib'

import { KiB, MiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { Attachment } from '../attachment/attachment.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { compression, type CompressionBuilder } from './compress.js'

/**
 * What the HTTP and coding RFCs ask of a server that compresses, one `describe` per section, each `it` naming the
 * requirement it checks.
 */

type AnyRouter = Router<any, any, any, any, any>

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => undefined)))
})

const TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
const BYTES = new TextEncoder().encode(TEXT)

function text(): AnyRouter {
  return new Router('/text').get('/').handler(ctx => {
    ctx.header('content-type', 'text/plain; charset=utf-8')
    return TEXT
  })
}

async function serve(configure?: (c: CompressionBuilder) => CompressionBuilder, ...routers: AnyRouter[]) {
  const built = createWebApplication()
    .with(compression(configure))
    .mount(text(), ...routers)
  apps.push(built)
  await built.bootstrap()
  return built
}

async function fetchText(accept: string | undefined, path = '/text', init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (accept !== undefined) {
    headers.set('accept-encoding', accept)
  }
  const app = await serve(undefined)
  return app.request(path, { ...init, headers })
}

async function wire(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer())
}

describe('RFC 9110 §8.4.1 content codings, registered names (§16.6.1)', () => {
  it.each(['GZIP', 'Gzip', 'gZiP'])('compares coding names without regard to case: %s selects gzip', async name => {
    const res = await fetchText(name)

    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  it('reads "x-gzip" as gzip, and answers with the registered name', async () => {
    const res = await fetchText('x-gzip')

    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  it('never answers with a coding it does not implement, such as compress', async () => {
    const res = await fetchText('compress')

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(await res.text()).toBe(TEXT)
  })
})

describe('the coded formats', () => {
  it('RFC 9110 §8.4.1.2: "deflate" is the zlib format (RFC 1950), not raw deflate', async () => {
    const bytes = await wire(await fetchText('deflate'))

    expect(bytes[0]).toBe(0x78)
    expect(((bytes[0]! << 8) | bytes[1]!) % 31).toBe(0)
    expect(inflateSync(bytes).toString()).toBe(TEXT)
    expect(() => inflateRawSync(bytes)).toThrow()
  })

  it('RFC 9110 §8.4.1.3: "gzip" is the RFC 1952 format: ID1 ID2 CM = 1f 8b 08', async () => {
    const bytes = await wire(await fetchText('gzip'))

    expect([...bytes.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08])
    expect(gunzipSync(bytes).toString()).toBe(TEXT)
  })

  it('RFC 7932: "br" is a Brotli stream', async () => {
    expect(brotliDecompressSync(await wire(await fetchText('br'))).toString()).toBe(TEXT)
  })

  it('RFC 8878 §3.1.1: "zstd" is a Zstandard frame, magic 28 b5 2f fd', async () => {
    const bytes = await wire(await fetchText('zstd'))

    expect([...bytes.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd])
    expect(zstdDecompressSync(bytes).toString()).toBe(TEXT)
  })
})

describe('RFC 9659 §3: a zstd window no larger than 8 MiB', () => {
  // RFC 8878 §3.1.1.1.2: the window a decoder must hold, from the Window_Descriptor of a frame that is not single
  // segment: 2^(10 + exponent) plus an eighth of that per unit of mantissa.
  function windowSize(frame: Buffer): number {
    const descriptor = frame[5]!
    const base = 2 ** (10 + (descriptor >> 3))
    return base + (base / 8) * (descriptor & 0x07)
  }

  it.each([3, 19])('streams 16 MiB at level %i within a 2^23 window', async level => {
    const chunk = new TextEncoder().encode('0123456789abcdef'.repeat(64 * KiB))
    const big = new Router('/big').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      let sent = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 16) {
            controller.close()
            return
          }
          sent++
          controller.enqueue(chunk)
        },
      })
    })
    const app = await serve(c => c.zstd({ level }), big)
    const frame = await wire(await app.request('/big', { headers: { 'accept-encoding': 'zstd' } }))

    // A streamed frame of unknown size is not single segment: its window is declared, and checked.
    expect(frame[4]! & 0x20).toBe(0)
    expect(windowSize(frame)).toBeLessThanOrEqual(8 * MiB)
    expect(zstdDecompressSync(frame).byteLength).toBe(16 * MiB)
  })
})

describe('RFC 9110 §12.5.3 Accept-Encoding', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['identity', null],
    ['*', 'zstd'],
    ['gzip;q=0, *', 'zstd'],
    ['br;q=0.5, gzip;q=0.8', 'gzip'],
    ['gzip;q=0.8, br;q=0.8', 'br'],
    ['  , gzip ,, br;q=0.1 ', 'gzip'],
  ])('answers %j with %s', async (header, coding) => {
    const res = await fetchText(header)

    expect(res.headers.get('content-encoding')).toBe(coding)
  })

  it('ignores an entry whose q is not a qvalue: more than three decimals or above 1', async () => {
    expect((await fetchText('gzip;q=1.001, br;q=0.5')).headers.get('content-encoding')).toBe('br')
    expect((await fetchText('gzip;q=0.0001, br;q=0.5')).headers.get('content-encoding')).toBe('br')
  })

  it('takes the first entry for a coding: "gzip;q=0, gzip" excludes gzip', async () => {
    expect((await fetchText('gzip;q=0, gzip')).headers.get('content-encoding')).toBe(null)
  })

  it('does not read a header of more than 32 entries, and sends identity', async () => {
    const header = [...Array.from({ length: 32 }, (_, i) => `x-${i}`), 'gzip'].join(', ')

    expect((await fetchText(header)).headers.get('content-encoding')).toBe(null)
  })

  // §12.5.3 lets a server answer without a coding when none is acceptable; the handler has run, so it never 406s.
  it('sends identity, never a 406, when "*;q=0" excludes everything', async () => {
    const res = await fetchText('*;q=0')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe(null)
  })
})

describe('RFC 9110 §12.5.5 Vary', () => {
  const varied = (vary: string) =>
    new Router('/varied').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      ctx.header('vary', vary)
      return TEXT
    })

  it('lists Accept-Encoding on an answer whose coding it chose, identity included', async () => {
    expect((await fetchText('gzip')).headers.get('vary')).toBe('Accept-Encoding')
    expect((await fetchText('identity')).headers.get('vary')).toBe('Accept-Encoding')
  })

  it.each([
    ['Origin', 'Origin, Accept-Encoding'],
    ['accept-encoding', 'accept-encoding'],
    ['*', '*'],
  ])('merges into a Vary of %j as %j', async (vary, merged) => {
    const app = await serve(undefined, varied(vary))
    const res = await app.request('/varied', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('vary')).toBe(merged)
  })
})

describe('RFC 9110 §8.6 Content-Length', () => {
  it('gives the length of the coded bytes, never the identity length', async () => {
    const res = await fetchText('br')
    const bytes = await wire(res)

    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(bytes.byteLength).not.toBe(BYTES.byteLength)
  })

  // A conditional route whose 304 carries the length its identity 200 would, declared or left for the server to
  // measure.
  const declared = () =>
    new Router('/declared').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain; charset=utf-8')
      if (ctx.req.header('if-none-match') !== '"v1"') {
        return TEXT
      }
      ctx.header('content-length', String(BYTES.byteLength))
      ctx.status(304)
      return null
    })
  const left = () =>
    new Router('/left').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain; charset=utf-8')
      if (ctx.req.header('if-none-match') === '"v1"') {
        ctx.status(304)
      }
      return TEXT
    })

  // A 304's Content-Length is its 200's, and the coded 200's length is not known without coding it.
  it.each(['/declared', '/left'])('sends no Content-Length on a 304 whose 200 would be coded: %s', async path => {
    const app = await serve(undefined, declared(), left())
    const ok = await app.request(path, { headers: { 'accept-encoding': 'gzip' } })
    const res = await app.request(path, { headers: { 'accept-encoding': 'gzip', 'if-none-match': '"v1"' } })

    expect(ok.headers.get('content-encoding')).toBe('gzip')
    expect(res.status).toBe(304)
    expect(res.headers.get('content-length')).toBe(null)
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect((await wire(res)).byteLength).toBe(0)
  })

  // A JSON 304's `null` serializes to bytes that are not the representation's, whether the route declares its length
  // or not.
  it.each([
    ['declares', true],
    ['does not declare', false],
  ])('sends no Content-Length on a JSON 304 whose route %s its length', async (_, declare) => {
    const pets = new Router('/pets').get('/').handler(ctx => {
      if (ctx.req.header('if-none-match') !== '"v1"') {
        return { text: TEXT }
      }
      if (declare) {
        ctx.header('content-length', String(BYTES.byteLength))
      }
      ctx.status(304)
      return null
    })
    const app = await serve(undefined, pets)
    const ok = await app.request('/pets', { headers: { 'accept-encoding': 'gzip' } })
    const res = await app.request('/pets', { headers: { 'accept-encoding': 'gzip', 'if-none-match': '"v1"' } })

    expect(ok.headers.get('content-encoding')).toBe('gzip')
    expect(res.status).toBe(304)
    expect(res.headers.get('content-length')).toBe(null)
    expect((await wire(res)).byteLength).toBe(0)
  })

  it('keeps the Content-Length of a 304 whose 200 would not be coded', async () => {
    const app = await serve(undefined, declared())
    const res = await app.request('/declared', { headers: { 'accept-encoding': 'identity', 'if-none-match': '"v1"' } })

    expect(res.status).toBe(304)
    expect(res.headers.get('content-length')).toBe(String(BYTES.byteLength))
  })

  it('keeps the Content-Length a route declares on a 304 whose 200 is under the threshold', async () => {
    const small = new Router('/small').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain; charset=utf-8')
      ctx.header('content-length', '100')
      ctx.status(304)
      return null
    })
    const app = await serve(undefined, small)
    const res = await app.request('/small', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(304)
    expect(res.headers.get('content-length')).toBe('100')
  })

  // The body a 304 drops is the handler's to release: a stream left open holds what it reads from.
  it('closes the stream a 304 whose 200 would be coded leaves unread', async () => {
    let closed!: () => void
    const cancelled = new Promise<void>(resolve => (closed = resolve))
    const streamed = new Router('/streamed').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain; charset=utf-8')
      ctx.status(304)
      return new ReadableStream<Uint8Array>({ pull: () => undefined, cancel: () => closed() })
    })
    const app = await serve(undefined, streamed)
    const res = await app.request('/streamed', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(304)
    expect(res.headers.get('content-length')).toBe(null)
    expect((await wire(res)).byteLength).toBe(0)
    await cancelled
  })
})

describe('RFC 9110 §8.8 validators, and 304 Not Modified', () => {
  const download = () =>
    new Router('/download')
      .get('/')
      .handler(() => Attachment(BYTES, { name: 'fox.txt', type: 'text/plain', etag: '"v1"' }))

  it("§8.8: keeps the route's tag on a compressed answer, so the tag a precondition compared is the one sent", async () => {
    const app = await serve(undefined, download())
    const coded = await app.request('/download', { headers: { 'accept-encoding': 'gzip' } })
    const identity = await app.request('/download', { headers: { 'accept-encoding': 'identity' } })

    expect(coded.headers.get('content-encoding')).toBe('gzip')
    expect(coded.headers.get('etag')).toBe('"v1"')
    expect(identity.headers.get('etag')).toBe('"v1"')
  })

  it("§15.4.5: sends a 304 the Vary its 200 carries, with the route's tag and no Content-Encoding", async () => {
    const app = await serve(undefined, download())
    const res = await app.request('/download', {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': '"v1"' },
    })

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(res.headers.get('content-encoding')).toBe(null)
    expect((await wire(res)).byteLength).toBe(0)
  })
})

describe('RFC 9530 §2 and §3 integrity fields, and RFC 1864 Content-MD5', () => {
  const DIGESTS = {
    'content-digest': 'sha-256=:identity-content:',
    'repr-digest': 'sha-256=:identity-representation:',
    'content-md5': 'aWRlbnRpdHk=',
  }
  const digested = () =>
    new Router('/digested').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      for (const [name, value] of Object.entries(DIGESTS)) {
        ctx.header(name, value)
      }
      return TEXT
    })

  it('drops the digests of the identity bytes from a compressed answer, where they no longer hold', async () => {
    const app = await serve(undefined, digested())
    const res = await app.request('/digested', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('content-digest')).toBe(null)
    expect(res.headers.get('repr-digest')).toBe(null)
    expect(res.headers.get('content-md5')).toBe(null)
  })

  it('keeps them on an identity answer, which they describe', async () => {
    const app = await serve(undefined, digested())
    const res = await app.request('/digested', { headers: { 'accept-encoding': 'identity' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('content-digest')).toBe(DIGESTS['content-digest'])
    expect(res.headers.get('repr-digest')).toBe(DIGESTS['repr-digest'])
    expect(res.headers.get('content-md5')).toBe(DIGESTS['content-md5'])
  })
})

describe('RFC 9110 §14 ranges', () => {
  const download = () =>
    new Router('/download')
      .get('/')
      .handler(() => Attachment(BYTES, { name: 'fox.txt', type: 'text/plain', etag: '"v1"' }))

  it('§14.2: answers a range with the identity bytes asked for, untouched', async () => {
    const app = await serve(undefined, download())
    const res = await app.request('/download', { headers: { 'accept-encoding': 'gzip', range: 'bytes=0-9' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${BYTES.byteLength}`)
    expect((await wire(res)).toString()).toBe(TEXT.slice(0, 10))
  })

  // §15.3.7 and §15.4.5: a 206 and a 304 carry the Vary the 200 would, what the route said added to.
  it('§15.3.7: sends the 200, a 206 and a 304 of one attachment the same Vary', async () => {
    const varied = new Router('/varied-download').get('/').handler(ctx => {
      ctx.header('vary', 'Origin')
      return Attachment(BYTES, { name: 'fox.txt', type: 'text/plain', etag: '"v1"' })
    })
    const app = await serve(undefined, varied)
    const whole = await app.request('/varied-download', { headers: { 'accept-encoding': 'gzip' } })
    const part = await app.request('/varied-download', { headers: { 'accept-encoding': 'gzip', range: 'bytes=0-9' } })
    const unchanged = await app.request('/varied-download', {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': '"v1"' },
    })

    expect([whole.status, part.status, unchanged.status]).toEqual([200, 206, 304])
    expect(whole.headers.get('vary')).toBe('Origin, Accept-Encoding')
    expect(part.headers.get('vary')).toBe('Origin, Accept-Encoding')
    expect(unchanged.headers.get('vary')).toBe('Origin, Accept-Encoding')
  })

  it('§15.3.7: sends a range of a type never compressed no Vary, as its 200 has none', async () => {
    const image = new Router('/image')
      .get('/')
      .handler(() => Attachment(new Uint8Array(4 * 1024), { name: 'a.png', type: 'image/png' }))
    const app = await serve(undefined, image)
    const whole = await app.request('/image', { headers: { 'accept-encoding': 'gzip' } })
    const part = await app.request('/image', { headers: { 'accept-encoding': 'gzip', range: 'bytes=0-9' } })

    expect(part.status).toBe(206)
    expect(whole.headers.get('vary')).toBe(null)
    expect(part.headers.get('vary')).toBe(null)
  })

  it('§14.3: drops Accept-Ranges from a compressed answer, whose bytes no range is served from', async () => {
    const app = await serve(undefined, download())
    const coded = await app.request('/download', { headers: { 'accept-encoding': 'gzip' } })
    const identity = await app.request('/download')

    expect(coded.headers.get('accept-ranges')).toBe(null)
    expect(identity.headers.get('accept-ranges')).toBe('bytes')
  })
})

describe('RFC 9110 §9.3.2 HEAD', () => {
  it('sends the head a GET would, coding, Vary and validators alike, with no body', async () => {
    const tagged = new Router('/tagged').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      ctx.header('etag', '"t"')
      return TEXT
    })
    const app = await serve(undefined, tagged)
    const get = await app.request('/tagged', { headers: { 'accept-encoding': 'br' } })
    const head = await app.request('/tagged', { method: 'HEAD', headers: { 'accept-encoding': 'br' } })

    for (const name of ['content-encoding', 'vary', 'etag', 'content-type']) {
      expect(head.headers.get(name)).toBe(get.headers.get(name))
    }
    expect((await wire(head)).byteLength).toBe(0)
  })

  it('sends, for the HEAD of a GET that answers with no body, the head of that GET: nothing to code', async () => {
    const nothing = new Router('/nothing').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return null
    })
    const app = await serve(undefined, nothing)
    const get = await app.request('/nothing', { headers: { 'accept-encoding': 'gzip' } })
    const head = await app.request('/nothing', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } })

    expect(get.headers.get('content-encoding')).toBe(null)
    expect(head.headers.get('content-encoding')).toBe(null)
    expect(head.headers.get('vary')).toBe(get.headers.get('vary'))
  })

  // A HEAD route of its own answers with no body: what it says of the GET's representation decides.
  it('sends, for a HEAD route that answers with no body, the head of the GET, with no identity length', async () => {
    const pair = new Router('/pair')
    pair.get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      ctx.header('etag', '"p1"')
      return TEXT
    })
    pair.head('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      ctx.header('content-length', String(BYTES.byteLength))
      ctx.header('etag', '"p1"')
      return null
    })
    const app = await serve(undefined, pair)
    const get = await app.request('/pair', { headers: { 'accept-encoding': 'gzip' } })
    const head = await app.request('/pair', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } })

    expect(get.headers.get('content-encoding')).toBe('gzip')
    for (const name of ['content-encoding', 'vary', 'etag', 'content-type']) {
      expect(head.headers.get(name)).toBe(get.headers.get(name))
    }
    expect(head.headers.get('content-length')).toBe(null)
    expect((await wire(head)).byteLength).toBe(0)
  })
})

describe('RFC 9110 §15.3.5 204 and §15.3.6 205', () => {
  it.each([204, 205])('sends a %i with no coding and no body', async status => {
    const empty = new Router('/empty').get('/').handler(ctx => {
      ctx.status(status)
      ctx.header('content-type', 'text/plain')
      return TEXT
    })
    const app = await serve(undefined, empty)
    const res = await app.request('/empty', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(status)
    expect(res.headers.get('content-encoding')).toBe(null)
    expect((await wire(res)).byteLength).toBe(0)
  })
})

describe('RFC 9110 §7.7 and RFC 9111 §5.2.2.6 no-transform', () => {
  const cached = (cacheControl: string) =>
    new Router('/cc').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      ctx.header('cache-control', cacheControl)
      return TEXT
    })

  it.each(['no-transform', 'public, no-transform', 'NO-TRANSFORM', 'max-age=60 ,no-transform'])(
    'sends %j as it is',
    async cacheControl => {
      const res = await (
        await serve(undefined, cached(cacheControl))
      ).request('/cc', {
        headers: { 'accept-encoding': 'gzip' },
      })

      expect(res.headers.get('content-encoding')).toBe(null)
    },
  )

  it('reads the directive as a token, not a substring: "no-transformx" is compressed', async () => {
    const res = await (
      await serve(undefined, cached('no-transformx'))
    ).request('/cc', {
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  // RFC 9111 §5.2: a quoted value is one value, commas included: "no-transform" inside one names a field.
  it.each([
    ['private="x-one,no-transform,x-two"', 'gzip'],
    ['private="x-one,no-transform,x-two", no-transform', null],
  ])('reads %j as a list of directives outside its quoted values', async (value, coding) => {
    const res = await (
      await serve(undefined, cached(value))
    ).request('/cc', {
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe(coding)
  })
})
