import { Agent, request as httpRequest, type IncomingMessage } from 'node:http'
import { connect as http2Connect } from 'node:http2'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import {
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'

import { Router } from '@caffeinejs/http'
import {
  compression,
  decompression,
  isCompressible,
  selectEncoding,
  type ContentCoding,
} from '@caffeinejs/http/compress'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'

/**
 * `compression()` and `decompression()` over real sockets, read by real clients: Node's `fetch` (undici), which decodes as a browser does;
 * `node:http`, which shows the bytes on the wire; the web `DecompressionStream`; and an HTTP/2 client. No external
 * system, so this spec never skips.
 */

const CODINGS = ['zstd', 'br', 'gzip', 'deflate'] as const

const DECODE: Record<ContentCoding, (bytes: Buffer) => Buffer> = {
  gzip: gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
  zstd: zstdDecompressSync,
}

const CATALOG = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, title: `item ${i}`, price: i * 3 })) }
const CATALOG_JSON = JSON.stringify(CATALOG)
const LARGE = { rows: Array.from({ length: 120_000 }, (_, i) => ({ i, label: `row-${i}` })) }

// The feed's records are written one at a time, each only once the client has read the one before.
let releases: (() => void)[] = []
// Resolved when the handler's stream is cancelled because its client went away.
let cancelled: PromiseWithResolvers<void> = Promise.withResolvers()

function routes(): Router<any, any, any, any, any>[] {
  const encoder = new TextEncoder()

  return [
    new Router('/catalog').get('/').handler(ctx => {
      // What the client offered, sent back so a test can tell what was negotiated from it.
      ctx.header('x-accept-encoding', ctx.req.header('accept-encoding') ?? '')
      return CATALOG
    }),
    new Router('/large').get('/').handler(() => LARGE),
    new Router('/feed').get('/').handler(ctx => {
      ctx.header('content-type', 'application/x-ndjson')
      let n = 0
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (n === 3) {
            controller.close()
            return
          }
          if (n > 0) {
            await new Promise<void>(resolve => releases.push(resolve))
          }
          controller.enqueue(encoder.encode(`${JSON.stringify({ n })}\n`))
          n++
        },
      })
    }),
    new Router('/endless').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      const chunk = encoder.encode('x'.repeat(16 * 1024))
      return new ReadableStream<Uint8Array>({
        pull: controller => controller.enqueue(chunk),
        cancel: () => cancelled.resolve(),
      })
    }),
    new Router('/chunks').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return Readable.from(['one ', 'two ', 'three'])
    }),
    new Router('/echo').post('/').handler(ctx => ({ received: ctx.req.body() })),
  ]
}

const ndjson = (type: string): boolean => isCompressible(type) || type.startsWith('application/x-ndjson')

interface Reply {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
  readonly socket: Socket
}

function call(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array; agent?: Agent } = {},
): Promise<Reply> {
  const url = new URL(path, origin)

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: url.port,
        path: url.pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: options.agent,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), socket: res.socket }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('compression() and decompression() over HTTP/1.1', () => {
  let running: RunningApp

  beforeAll(async () => {
    running = await startApp(app =>
      app
        .with(compression(c => c.compressible(ndjson)))
        .with(decompression())
        .mount(...routes()),
    )
  })

  afterAll(() => running.close())

  it("is decoded by Node's fetch, in the coding negotiated from what fetch offers", async () => {
    const res = await fetch(`${running.origin}/catalog`)
    const offered = res.headers.get('x-accept-encoding')!

    expect(res.status).toBe(200)
    expect(offered).not.toBe('')
    expect(res.headers.get('content-encoding')).toBe(selectEncoding(offered, CODINGS))
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(await res.json()).toEqual(CATALOG)
  })

  it.each(CODINGS)('puts %s on the wire, with the length of the coded bytes', async coding => {
    const res = await call(running.origin, '/catalog', { headers: { 'accept-encoding': coding } })

    expect(res.headers['content-encoding']).toBe(coding)
    expect(res.headers['content-length']).toBe(String(res.body.byteLength))
    expect(DECODE[coding](res.body).toString()).toBe(CATALOG_JSON)
  })

  it('serves coded and identity answers one after another on one kept-alive connection', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const accepts = ['gzip', 'identity', 'br', 'zstd', 'identity', 'deflate', 'gzip', 'br', 'identity', 'zstd']

    try {
      const replies: Reply[] = []
      for (const accept of accepts) {
        replies.push(await call(running.origin, '/catalog', { headers: { 'accept-encoding': accept }, agent }))
      }

      for (const [i, reply] of replies.entries()) {
        const coding = reply.headers['content-encoding'] as ContentCoding | undefined
        expect(coding).toBe(accepts[i] === 'identity' ? undefined : accepts[i])
        expect((coding === undefined ? reply.body : DECODE[coding](reply.body)).toString()).toBe(CATALOG_JSON)
        expect(reply.socket).toBe(replies[0]!.socket)
      }
    } finally {
      agent.destroy()
    }
  })

  it.each([
    ['gzip', 'gzip'],
    ['deflate', 'deflate'],
    ['br', 'brotli'],
  ] as const)('is decoded by the web DecompressionStream: %s', async (coding, format) => {
    const body = await new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      const url = new URL('/catalog', running.origin)
      httpRequest(
        { host: '127.0.0.1', port: url.port, path: url.pathname, headers: { 'accept-encoding': coding } },
        res => resolve(Readable.toWeb(res) as ReadableStream<Uint8Array>),
      )
        .on('error', reject)
        .end()
    })

    const decoder = new DecompressionStream(format)
    // The decoder reads any buffer source; the body is bytes, one kind of it.
    void body.pipeTo(decoder.writable as WritableStream<Uint8Array>)
    const text = await new Response(decoder.readable).text()

    expect(text).toBe(CATALOG_JSON)
  })

  it('streams a feed: each record arrives decoded before the next is written', async () => {
    releases = []
    const res = await fetch(`${running.origin}/feed`, { headers: { 'accept-encoding': 'gzip' } })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    const records: string[] = []
    let text = ''

    expect(res.headers.get('content-encoding')).toBe('gzip')

    while (records.length < 3) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      text += next.value
      const lines = text.split('\n')
      text = lines.pop()!
      records.push(...lines)
      // The server writes the next record only now.
      releases.shift()?.()
    }

    expect(records).toEqual(['{"n":0}', '{"n":1}', '{"n":2}'])
  })

  it("closes the handler's stream when the client goes away mid-answer, and keeps serving", async () => {
    cancelled = Promise.withResolvers()
    const url = new URL('/endless', running.origin)

    const coding = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: url.port, path: url.pathname, headers: { 'accept-encoding': 'gzip' } },
        res => {
          res.once('data', () => {
            req.destroy()
            resolve(res.headers['content-encoding'])
          })
        },
      )
      req.on('error', err => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(err)))
      req.end()
    })

    expect(coding).toBe('gzip')
    await cancelled.promise
    const next = await fetch(`${running.origin}/catalog`)
    expect(next.status).toBe(200)
  })

  it('decodes uploads: a gzip body with a length, and a streamed zstd body without one', async () => {
    const json = JSON.stringify({ name: 'Rex', tags: ['good'] })

    const sized = await fetch(`${running.origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(json),
    })
    const coded = zstdCompressSync(json)
    const streamed = await fetch(`${running.origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(coded.subarray(0, 4))
          controller.enqueue(coded.subarray(4))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)

    expect(sized.status).toBe(200)
    expect(await sized.json()).toEqual({ received: JSON.parse(json) })
    expect(streamed.status).toBe(200)
    expect(await streamed.json()).toEqual({ received: JSON.parse(json) })
  })

  it('refuses a decompression bomb with a 413, and keeps serving', async () => {
    const bomb = zstdCompressSync(new Uint8Array(128 * 1024 * 1024))

    const refused = await fetch(`${running.origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: bomb,
    })
    const next = await fetch(`${running.origin}/catalog`)

    expect(bomb.byteLength).toBeLessThan(16 * 1024)
    expect(refused.status).toBe(413)
    expect(next.status).toBe(200)
  })

  it('refuses a coding it does not decode with a 415 that names those it does', async () => {
    const res = await fetch(`${running.origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'lzma' },
      body: '{}',
    })

    expect(res.status).toBe(415)
    expect(res.headers.get('accept-encoding')).toBe('zstd, br, gzip, deflate')
  })

  it.each(CODINGS)('sends more than 3 MiB of JSON intact in %s', async coding => {
    expect(Buffer.byteLength(JSON.stringify(LARGE))).toBeGreaterThan(3 * 1024 * 1024)
    const res = await call(running.origin, '/large', { headers: { 'accept-encoding': coding } })

    expect(res.headers['content-encoding']).toBe(coding)
    expect(JSON.parse(DECODE[coding](res.body).toString())).toEqual(LARGE)
  })
})

describe('compression() over HTTP/2', () => {
  let running: RunningApp

  beforeAll(async () => {
    running = await startApp(app =>
      app
        .server(() => ({ http2: true }))
        .with(compression())
        .mount(...routes()),
    )
  })

  afterAll(() => running.close())

  function h2Get(path: string, accept: string): Promise<{ headers: Record<string, unknown>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const session = http2Connect(running.origin.replace('localhost', '127.0.0.1'))
      session.on('error', reject)
      const stream = session.request({ ':path': path, 'accept-encoding': accept })
      const chunks: Buffer[] = []
      let headers: Record<string, unknown> = {}
      stream.on('response', received => (headers = received))
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        session.close()
        resolve({ headers, body: Buffer.concat(chunks) })
      })
      stream.on('error', reject)
      stream.end()
    })
  }

  it('compresses an answer, with its length', async () => {
    const res = await h2Get('/catalog', 'gzip')

    expect(res.headers[':status']).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['content-length']).toBe(String(res.body.byteLength))
    expect(gunzipSync(res.body).toString()).toBe(CATALOG_JSON)
  })

  it('compresses a streamed answer, which carries no length', async () => {
    const res = await h2Get('/chunks', 'br')

    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-length']).toBe(undefined)
    expect(brotliDecompressSync(res.body).toString()).toBe('one two three')
  })
})
