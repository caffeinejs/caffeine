import { randomBytes } from 'node:crypto'
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib'

import { KiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { bodyAsBuffer, bodyAsStream } from '../../index.js'
import { node } from '../../platform/node/node.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrHTTP } from '../error/http.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { ContentCoding } from './compress.js'
import { ENCODE, send } from './compress.testkit.js'
import { decompress, decompression, type DecompressionBuilder } from './decompression.js'

// Any router, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => undefined)))
})

const PETS = { pets: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `pet number ${i}` })) }
const PETS_JSON = JSON.stringify(PETS)

/** `/pets`, a GET, beside whatever routers the case adds. */
function pets(): AnyRouter {
  return new Router('/pets').get('/').handler(() => PETS)
}

async function serve(...routers: AnyRouter[]) {
  return serveWith(undefined, ...routers)
}

async function serveWith(
  configure: ((d: DecompressionBuilder) => DecompressionBuilder) | undefined,
  ...routers: AnyRouter[]
) {
  const built = createWebApplication()
    .with(decompression(configure))
    .mount(pets(), ...routers)
  apps.push(built)
  await built.bootstrap()
  return built
}

function post(coding: string | undefined, body: Uint8Array, path = '/echo'): [string, RequestInit] {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (coding !== undefined) {
    headers['content-encoding'] = coding
  }
  return [path, { method: 'POST', headers, body }]
}

describe('decompression() decoding request bodies', () => {
  const echo = () => new Router('/echo').post('/').handler(ctx => ctx.req.body())

  it.each(['zstd', 'br', 'gzip', 'deflate'] as const)('decodes a %s JSON body for the parser', async coding => {
    const res = await (await serve(echo())).request(...post(coding, ENCODE[coding](Buffer.from(PETS_JSON))))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PETS_JSON)
  })

  it.each([
    ['identity', Buffer.from('{"a":1}')],
    ['x-gzip', gzipSync('{"a":1}')],
    ['GZIP', gzipSync('{"a":1}')],
    ['gzip, identity', gzipSync('{"a":1}')],
  ])('reads a body sent as %j', async (coding, body) => {
    const res = await (await serve(echo())).request(...post(coding, body))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ a: 1 })
  })

  it('refuses a coding it does not decode with a 415 that lists what it does', async () => {
    const res = await (await serve(echo())).request(...post('lzma', Buffer.from('{}')))

    expect(res.status).toBe(415)
    expect(res.headers.get('accept-encoding')).toBe('zstd, br, gzip, deflate')
  })

  it('refuses a body coded twice with a 415', async () => {
    const res = await (await serve(echo())).request(...post('gzip, br', brotliCompressSync(gzipSync('{}'))))

    expect(res.status).toBe(415)
  })

  it('answers a body that is not the coding it says with a 400', async () => {
    const res = await (await serve(echo())).request(...post('gzip', Buffer.from('not gzip at all')))

    expect(res.status).toBe(400)
  })

  // Bytes after the coded content are not part of it: decoding only what comes before would hand the route part of
  // what the client sent.
  it.each(['zstd', 'br', 'gzip', 'deflate'] as const)(
    'answers %s content followed by other bytes with a 400',
    async coding => {
      const res = await (
        await serve(echo())
      ).request(...post(coding, Buffer.concat([ENCODE[coding](Buffer.from('{"a":1}')), Buffer.from('trailing junk')])))

      expect(res.status).toBe(400)
    },
  )

  it.each(['zstd', 'br', 'gzip', 'deflate'] as const)(
    'answers %s content followed by other bytes with a 400 when the route streams it',
    async coding => {
      const streamed = new Router('/stream')
        .post('/')
        .extend(bodyAsStream())
        .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
      const res = await (
        await serve(streamed)
      ).request(
        ...post(
          coding,
          Buffer.concat([ENCODE[coding](Buffer.from('{"a":1}')), Buffer.from('trailing junk')]),
          '/stream',
        ),
      )

      expect(res.status).toBe(400)
    },
  )

  // Content cut short decodes to part of what the client sent: a route that reads the raw bytes would take it whole.
  it.each(['zstd', 'br', 'gzip', 'deflate'] as const)(
    'answers %s content cut short with a 400, buffered and streamed',
    async coding => {
      const buffered = new Router('/raw')
        .post('/')
        .extend(bodyAsBuffer())
        .handler(ctx => ({ size: (ctx.req.body() as Buffer).byteLength }))
      const streamed = new Router('/stream')
        .post('/')
        .extend(bodyAsStream())
        .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
      const app = await serve(buffered, streamed)
      const coded = ENCODE[coding](Buffer.from(PETS_JSON))
      const cut = coded.subarray(0, coded.byteLength - 4)

      const raw = await app.request(...post(coding, cut, '/raw'))
      const stream = await app.request(...post(coding, cut, '/stream'))

      expect(raw.status).toBe(400)
      expect(stream.status).toBe(400)
    },
  )

  // RFC 8878 §3.1: zstd content is one or more frames, each decoded in turn.
  it('decodes zstd content of two frames sent together, buffered and streamed', async () => {
    const buffered = new Router('/raw')
      .post('/')
      .extend(bodyAsBuffer())
      .handler(ctx => (ctx.req.body() as Buffer).toString())
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const app = await serve(buffered, streamed)
    const body = Buffer.concat([zstdCompressSync(PETS_JSON.slice(0, 100)), zstdCompressSync(PETS_JSON.slice(100))])

    const raw = await app.request(...post('zstd', body, '/raw'))
    const stream = await app.request(...post('zstd', body, '/stream'))

    expect([raw.status, stream.status]).toEqual([200, 200])
    expect(await raw.text()).toBe(PETS_JSON)
    expect(await stream.text()).toBe(PETS_JSON)
  })

  // A frame whose header the body ends inside is content cut short, though the frames before it are whole.
  it('answers zstd content that ends inside a second frame header with a 400, buffered and streamed', async () => {
    const buffered = new Router('/raw')
      .post('/')
      .extend(bodyAsBuffer())
      .handler(ctx => ({ size: (ctx.req.body() as Buffer).byteLength }))
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const app = await serve(buffered, streamed)
    const body = Buffer.concat([zstdCompressSync(PETS_JSON), zstdCompressSync(PETS_JSON).subarray(0, 3)])

    const raw = await app.request(...post('zstd', body, '/raw'))
    const stream = await app.request(...post('zstd', body, '/stream'))

    expect([raw.status, stream.status]).toEqual([400, 400])
  })

  // Past 16 KiB the body is decoded on the threadpool, by another call than the one in place.
  it('answers zstd content decoded off the calling thread that ends inside a second frame header with a 400, buffered and streamed', async () => {
    const random = randomBytes(64 * KiB)
    const buffered = new Router('/sized-raw')
      .post('/')
      .bodyLimit(128 * KiB)
      .extend(bodyAsBuffer())
      .handler(ctx => ({ size: (ctx.req.body() as Buffer).byteLength }))
    const streamed = new Router('/sized-stream')
      .post('/')
      .bodyLimit(128 * KiB)
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const app = await serve(buffered, streamed)
    const body = Buffer.concat([zstdCompressSync(random), zstdCompressSync(random).subarray(0, 3)])

    const raw = await app.request(...post('zstd', body, '/sized-raw'))
    const stream = await app.request(...post('zstd', body, '/sized-stream'))

    expect(body.byteLength).toBeGreaterThan(16 * KiB)
    expect([raw.status, stream.status]).toEqual([400, 400])
  })

  // gunzip reads zero bytes after a member as the padding some writers leave, and decodes the member.
  it('decodes gzip content followed by zero padding, buffered and streamed', async () => {
    const padded = Buffer.concat([gzipSync('{"a":1}'), Buffer.alloc(4)])
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const app = await serve(echo(), streamed)

    const buffered = await app.request(...post('gzip', padded))
    const stream = await app.request(...post('gzip', padded, '/stream'))

    expect(buffered.status).toBe(200)
    expect(await buffered.json()).toEqual({ a: 1 })
    expect(stream.status).toBe(200)
    expect(await stream.text()).toBe('{"a":1}')
  })

  // Padding is zeros to the end: a zero byte then others is not padding, and the others are not part of the content.
  it('answers gzip content followed by a zero byte and other bytes with a 400, buffered and streamed', async () => {
    const tail = Buffer.concat([gzipSync('{"a":1}'), Buffer.from([0]), Buffer.from('junk')])
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const app = await serve(echo(), streamed)

    expect((await app.request(...post('gzip', tail))).status).toBe(400)
    expect((await app.request(...post('gzip', tail, '/stream'))).status).toBe(400)
  })

  type Upstream = ReadableStreamDefaultController<Uint8Array>

  // gunzip ends its output at a zero byte after a member, while the request body may still be coming: the rest of the
  // body is read before the decoded one ends, so what comes after the padding is checked and a failure reaches the
  // reader.
  it.each([
    [
      'other bytes',
      (c: Upstream) => {
        c.enqueue(Buffer.from('junk'))
        c.close()
      },
      400,
    ],
    [
      'more zero padding',
      (c: Upstream) => {
        c.enqueue(Buffer.alloc(3))
        c.close()
      },
      'ended',
    ],
    ['a failure of the body', (c: Upstream) => c.error(new Error('gone')), 'gone'],
  ] as const)('reads a streamed gzip body past its padding to the end: %s', async (_, then, outcome) => {
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(Buffer.concat([gzipSync('{"a":1}'), Buffer.alloc(1)]))
          return
        }
        await held
        then(controller)
      },
    })
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => {
        const reader = (ctx.req.body() as ReadableStream<Uint8Array>).getReader()
        const first = await reader.read()
        const rest = reader.read().then(
          next => (next.done ? 'ended' : 'more'),
          (err: unknown) => (err instanceof ErrHTTP ? err.statusCode : (err as Error).message),
        )
        // One turn of the event loop: an end already decided is settled by then.
        const early = await Promise.race([
          rest.then(() => true),
          new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
        ])
        release()
        return { content: Buffer.from(first.value!).toString(), early, rest: await rest }
      })
    const app = await serve(streamed)

    const res = await app.request('/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body,
      duplex: 'half',
    } as RequestInit)

    expect(await res.json()).toEqual({ content: '{"a":1}', early: false, rest: outcome })
  })

  it('stops reading a streamed body once it is known not to be its coding', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull: controller => controller.enqueue(Buffer.from('not gzip at all')),
      cancel: () => {
        cancelled = true
      },
    })
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const app = await serve(streamed)

    const res = await app.request('/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body,
      duplex: 'half',
    } as RequestInit)

    expect(res.status).toBe(400)
    expect(cancelled).toBe(true)
  })

  it("decodes only the route's own codings", async () => {
    const gzipOnly = new Router('/only')
      .extend(decompress('gzip'))
      .post('/')
      .handler(ctx => ctx.req.body())
    const res = await (await serve(gzipOnly)).request(...post('br', brotliCompressSync('{}'), '/only'))

    expect(res.status).toBe(415)
    expect(res.headers.get('accept-encoding')).toBe('gzip')
  })

  it('hands a route with decompress(false) the coded bytes as they came', async () => {
    const coded = gzipSync('{"a":1}')
    const raw = new Router('/raw')
      .extend(decompress(false))
      .post('/')
      .extend(bodyAsBuffer())
      .handler(ctx => ({ size: (ctx.req.body() as Buffer).byteLength }))
    const res = await (await serve(raw)).request(...post('gzip', coded, '/raw'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size: coded.byteLength })
  })

  // Coded bytes past 16 KiB are decoded on the threadpool, where those below are decoded in place.
  it.each(['gzip', 'deflate', 'br', 'zstd'] as const)(
    'decodes a %s body too large to decode in place, and refuses one that inflates past the limit',
    async coding => {
      const random = randomBytes(64 * KiB)
      const sized = new Router('/sized')
        .post('/')
        .bodyLimit(128 * KiB)
        .extend(bodyAsBuffer())
        .handler(ctx => ({ same: Buffer.compare(ctx.req.body() as Buffer, random) === 0 }))
      const app = await serve(sized)
      const coded = ENCODE[coding](random)
      // Under the limit coded, past it decoded.
      const over = ENCODE[coding](Buffer.concat([random, Buffer.alloc(128 * KiB)]))

      expect(coded.byteLength).toBeGreaterThan(16 * KiB)
      expect(over.byteLength).toBeLessThan(128 * KiB)
      expect(await (await app.request(...post(coding, coded, '/sized'))).json()).toEqual({ same: true })
      expect((await app.request(...post(coding, over, '/sized'))).status).toBe(413)
    },
  )

  // The hook runs for every method of a route that takes a body under one of them: a GET's header is not a body's.
  it('leaves a GET alone on a route that also takes POST, whatever Content-Encoding it names', async () => {
    const both = new Router('/both').route(['GET', 'POST'], '/').handler(ctx => ({ method: ctx.req.method }))
    const app = await serve(both)

    const get = await app.request('/both', { headers: { 'content-encoding': 'lzma' } })
    const posted = await app.request(...post('lzma', Buffer.from('{}'), '/both'))

    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ method: 'GET' })
    expect(posted.status).toBe(415)
  })

  // A client that sets its coding on every request sends it on an empty body too.
  it.each(['gzip', 'br', 'zstd', 'deflate'])('reads an empty body sent as %s as empty', async coding => {
    const raw = new Router('/empty')
      .post('/')
      .extend(bodyAsBuffer())
      .handler(ctx => ({ size: (ctx.req.body() as Buffer).byteLength }))
    const res = await (await serve(raw)).request(...post(coding, new Uint8Array(0), '/empty'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size: 0 })
  })

  it('reads an empty streamed body sent as gzip as empty', async () => {
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => ({
        size: (await new Response(ctx.req.body() as ReadableStream<Uint8Array>).arrayBuffer()).byteLength,
      }))
    const res = await (
      await serve(streamed)
    ).request('/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      duplex: 'half',
    } as RequestInit)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size: 0 })
  })

  // What failed is the upload, not its coding: a 400 would blame the client's bytes.
  it('lets a streamed body that fails reach the route as its own failure, not as invalid content', async () => {
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => {
        try {
          await new Response(ctx.req.body() as ReadableStream<Uint8Array>).arrayBuffer()
          return { failed: false }
        } catch (err) {
          return { failed: true, invalid: (err as Error).message.includes('not valid') }
        }
      })
    const coded = gzipSync(PETS_JSON)
    const res = await (
      await serve(streamed)
    ).request('/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(coded.subarray(0, 20))
          controller.error(new Error('the client went away'))
        },
      }),
      duplex: 'half',
    } as RequestInit)

    expect(await res.json()).toEqual({ failed: true, invalid: false })
  })

  it('never decodes a GET, whose body is not read', async () => {
    const res = await (await serve()).request('/pets', { headers: { 'content-encoding': 'lzma' } })

    expect(res.status).toBe(200)
  })

  it('hands a stream route the decoded stream', async () => {
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const res = await (await serve(streamed)).request(...post('br', brotliCompressSync(PETS_JSON), '/stream'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PETS_JSON)
  })

  it('holds the coded bytes of a stream to the limit as well, with a 413', async () => {
    // Over the limit coded, under it decoded: only the limit on the coded bytes refuses it.
    const decodedSize = 1 * KiB - 14
    const coded = gzipSync(randomBytes(decodedSize))
    const streamed = new Router('/stream')
      .post('/')
      .bodyLimit(1 * KiB)
      .extend(bodyAsStream())
      .handler(async ctx => (await new Response(ctx.req.body() as ReadableStream<Uint8Array>).arrayBuffer()).byteLength)
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(coded)
        controller.close()
      },
    })
    const res = await (
      await serve(streamed)
    ).request('/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: chunked,
      duplex: 'half',
    } as RequestInit)

    expect(coded.byteLength).toBeGreaterThan(1 * KiB)
    expect(decodedSize).toBeLessThan(1 * KiB)
    expect(res.status).toBe(413)
  })
})

describe('decompression() under node()', () => {
  async function listen(...routers: AnyRouter[]): Promise<string> {
    const built = createWebApplication({ adapter: node() })
      .with(decompression())
      .mount(...routers)
    apps.push(built)
    const { address } = await built.run({ host: '127.0.0.1', port: 0 })
    return `http://127.0.0.1:${address!.port}`
  }

  it('decodes a request body read by the Node platform', async () => {
    const origin = await listen(new Router('/echo').post('/').handler(ctx => ctx.req.body()))
    const res = await send(origin, '/echo', {
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: zstdCompressSync('{"a":1}'),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ a: 1 })
  })

  it('decodes a request body streamed through the Node platform', async () => {
    const streamed = new Router('/stream')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => new Response(ctx.req.body() as ReadableStream<Uint8Array>).text())
    const origin = await listen(streamed)
    const res = await send(origin, '/stream', {
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'deflate' },
      body: deflateSync('streamed through'),
    })

    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('streamed through')
  })
})

describe('two decompression() over one route', () => {
  async function nested() {
    const api = new Router('/api').with(decompression(d => d.encodings('gzip')))
    api.post('/').handler(ctx => ctx.req.body())
    const other = new Router('/other').post('/').handler(ctx => ctx.req.body())
    const built = createWebApplication()
      .with(decompression(d => d.encodings('br')))
      .mount(api, other)
    apps.push(built)
    await built.bootstrap()
    return built
  }

  it("lets the router's, the innermost, decide which codings its routes decode", async () => {
    const built = await nested()

    const gzip = await built.request(...post('gzip', gzipSync('{"a":1}'), '/api'))
    const br = await built.request(...post('br', brotliCompressSync('{"a":1}'), '/api'))

    expect(gzip.status).toBe(200)
    expect(await gzip.json()).toEqual({ a: 1 })
    expect(br.status).toBe(415)
    expect(br.headers.get('accept-encoding')).toBe('gzip')
  })

  it("keeps the server's for a router without one of its own", async () => {
    const built = await nested()

    const br = await built.request(...post('br', brotliCompressSync('{"a":1}'), '/other'))
    const gzip = await built.request(...post('gzip', gzipSync('{"a":1}'), '/other'))

    expect(br.status).toBe(200)
    expect(await br.json()).toEqual({ a: 1 })
    expect(gzip.status).toBe(415)
    expect(gzip.headers.get('accept-encoding')).toBe('br')
  })
})

describe('decompression() reading its settings once', () => {
  it('keeps the codings it was built with when the list handed to config(...) changes later', async () => {
    const list: ContentCoding[] = ['gzip']
    const app = await serveWith(
      d => d.config({ encodings: list }),
      new Router('/echo').post('/').handler(ctx => ctx.req.body()),
    )
    list.push('br')

    const res = await app.request(...post('br', brotliCompressSync('{"a":1}')))

    expect(res.status).toBe(415)
    expect(res.headers.get('accept-encoding')).toBe('gzip')
  })
})

describe('decompression() refusing settings at start-up', () => {
  async function refusal(build: () => Promise<unknown>): Promise<string> {
    const failure = await build().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(ErrConfiguration)
    return (failure as Error).message.split('\n')[0]!
  }

  it.each([
    [{ encodings: [] }, 'Cannot build decompression(): "encodings" lists no coding'],
    [{ encodings: ['lzma'] }, 'Cannot build decompression(): "lzma" is not a content coding'],
    [{ encodings: ['gzip', 'gzip'] }, 'Cannot build decompression(): "gzip" is listed twice in "encodings"'],
    [{ encodings: 'gzip' }, 'Cannot build decompression(): "encodings" must be a list of codings'],
    [{ level: 1 }, 'Cannot build decompression(): "level" is not a decompression setting'],
  ])('refuses %j', async (config, message) => {
    expect(await refusal(() => serveWith(d => d.config(config as never)))).toBe(message)
  })

  it('refuses encodings() called with no coding after one with codings: the call empties the list', async () => {
    expect(await refusal(() => serveWith(d => d.encodings('gzip').encodings()))).toBe(
      'Cannot build decompression(): "encodings" lists no coding',
    )
  })

  it('refuses encodings() called with no coding', async () => {
    expect(await refusal(() => serveWith(d => d.encodings()))).toBe(
      'Cannot build decompression(): "encodings" lists no coding',
    )
  })

  it("refuses a route's decompress(...) that lists no coding", async () => {
    const route = new Router('/r')
      .extend(decompress([]))
      .post('/')
      .handler(() => 'r')

    expect(await refusal(() => serve(route))).toBe('Cannot serve "POST /r": "decompress" lists no coding')
  })

  it("refuses a route's decompress(...) with an unknown coding", async () => {
    const route = new Router('/r')
      .extend(decompress(['lzma'] as never))
      .post('/')
      .handler(() => 'r')

    expect(await refusal(() => serve(route))).toBe('Cannot serve "POST /r": "lzma" is not a content coding')
  })

  it("tells a route's decompress(...) that is not a list how to write one", async () => {
    const route = new Router('/r')
      .extend(decompress(5 as never))
      .post('/')
      .handler(() => 'r')
    const failure = await serve(route).then(
      () => undefined,
      (err: unknown) => err as Error,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect(failure!.message.split('\n')[0]).toBe('Cannot serve "POST /r": "decompress" must be a list of codings')
    expect(failure!.message.split('\n')).toContain("  - Write decompress(['gzip', 'br']) or decompress(false)")
  })

  it('refuses a second decompression() in one slot', async () => {
    const built = createWebApplication().with(decompression()).with(decompression()).mount(pets())
    apps.push(built)

    expect(await refusal(() => built.bootstrap())).toBe(
      `Cannot register plugin "caffeine-decompression" twice on the application's own server`,
    )
  })
})
