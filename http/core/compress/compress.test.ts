import { Readable } from 'node:stream'
import { brotliCompressSync, constants, deflateSync, gunzipSync, gzipSync, zstdCompressSync } from 'node:zlib'

import { $t } from '@caffeinejs/application/schema'
import { KiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { node } from '../../platform/node/node.js'
import { HTTPPlugin } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { compress, compression, type CompressionBuilder, type ContentCoding } from './compress.js'
import { DECODE, decodeAs, send } from './compress.testkit.js'

// Any router, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => undefined)))
})

/** JSON above the default threshold of 1 KiB. */
const PETS = { pets: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `pet number ${i}` })) }
const PETS_JSON = JSON.stringify(PETS)

/** `/pets`, JSON over the threshold, beside whatever routers the case adds. */
function pets(): AnyRouter {
  return new Router('/pets').get('/').handler(() => PETS)
}

async function serve(configure: ((c: CompressionBuilder) => CompressionBuilder) | undefined, ...routers: AnyRouter[]) {
  const built = createWebApplication()
    .with(compression(configure))
    .mount(pets(), ...routers)
  apps.push(built)
  await built.bootstrap()
  return built
}

async function bytesOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer())
}

async function decoded(res: Response): Promise<string> {
  return decodeAs(res.headers.get('content-encoding'), await bytesOf(res)).toString()
}

describe('compression() choosing a coding', () => {
  it.each(['zstd', 'br', 'gzip', 'deflate'] as const)(
    'compresses with %s for a client that accepts it alone, with the length of the coded bytes',
    async coding => {
      const res = await (await serve(undefined)).request('/pets', { headers: { 'accept-encoding': coding } })
      const bytes = await bytesOf(res)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe(coding)
      expect(res.headers.get('content-length')).toBe(String(bytes.byteLength))
      expect(res.headers.get('vary')).toBe('Accept-Encoding')
      expect(JSON.parse(DECODE[coding](bytes).toString())).toEqual(PETS)
    },
  )

  // The handler has run: a 406 would throw its answer away.
  it.each(['compress, identity;q=0', '*;q=0', 'identity;q=0'])(
    'sends identity, with a 200, when %j accepts no coding offered',
    async header => {
      const res = await (await serve(undefined)).request('/pets', { headers: { 'accept-encoding': header } })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe(null)
      expect(await res.text()).toBe(PETS_JSON)
    },
  )

  it('sends identity to a client that sends no Accept-Encoding, and still varies on it', async () => {
    const res = await (await serve(undefined)).request('/pets')

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(await res.text()).toBe(PETS_JSON)
  })
})

describe('compression() reading Accept-Encoding', () => {
  // The schema's output is the handler's; the coding is chosen from the field the client sent.
  it('negotiates from the field as sent, whatever a route schema made of it for the handler', async () => {
    const listed = new Router('/listed')
      .get('/')
      .schema({ headers: $t.Object({ 'accept-encoding': $t.Array($t.String()) }) })
      .handler(ctx => ({ received: ctx.req.header('accept-encoding') as unknown, rows: PETS.pets }))
    const res = await (await serve(undefined, listed)).request('/listed', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(JSON.parse(await decoded(res))).toEqual({ received: ['gzip'], rows: PETS.pets })
  })
})

describe('compression() deciding what is worth compressing', () => {
  const sized = (size: number) => new Router('/sized').get('/').handler(() => 'a'.repeat(size))

  it('leaves a body under the threshold alone, and does not vary on Accept-Encoding for it', async () => {
    const res = await (
      await serve(undefined, sized(1023))
    ).request('/sized', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe(null)
    expect(await res.text()).toBe('a'.repeat(1023))
  })

  it('compresses a body of exactly the threshold', async () => {
    const res = await (
      await serve(undefined, sized(1024))
    ).request('/sized', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(await decoded(res)).toBe('a'.repeat(1024))
  })

  // The largest count of bytes configuration reads, `$t.Bytes()` as `parseBytes`: one past it is refused.
  it('takes the largest safe count of bytes as the threshold, and refuses one past it', async () => {
    const res = await (
      await serve(c => c.threshold(Number.MAX_SAFE_INTEGER), sized(4 * KiB))
    ).request('/sized', { headers: { 'accept-encoding': 'gzip' } })
    const past = await serve(c => c.threshold(2 ** 53)).then(
      () => undefined,
      (err: unknown) => (err as Error).message.split('\n')[0],
    )

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(past).toBe('Cannot build compression(): "threshold" must be a size in bytes')
  })

  it('leaves a type that is not compressible alone', async () => {
    const png = new Router('/png').get('/').handler(ctx => {
      ctx.header('content-type', 'image/png')
      return new Uint8Array(4 * KiB)
    })
    const res = await (await serve(undefined, png)).request('/png', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe(null)
    expect((await bytesOf(res)).byteLength).toBe(4 * KiB)
  })

  it('leaves an event stream alone, so each event reaches the client as it is sent', async () => {
    const events = new Router('/events').get('/').handler(ctx => {
      ctx.header('content-type', 'text/event-stream')
      return new Response(new Blob(['data: one\n\n']).stream())
    })
    const res = await (await serve(undefined, events)).request('/events', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(await res.text()).toBe('data: one\n\n')
  })

  it('leaves an answer already coded alone, with its one Content-Encoding', async () => {
    const coded = gzipSync(PETS_JSON)
    const precoded = new Router('/coded')
      .get('/')
      .handler(
        () => new Response(coded, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
      )
    const res = await (await serve(undefined, precoded)).request('/coded', { headers: { 'accept-encoding': 'br' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(await bytesOf(res)).toEqual(coded)
  })

  it('uses the compressible function given in place of the default', async () => {
    const feed = new Router('/feed').get('/').handler(ctx => {
      ctx.header('content-type', 'application/x-ndjson')
      return '{"n":1}\n'.repeat(200)
    })
    const res = await (
      await serve(c => c.compressible(type => type.startsWith('application/x-ndjson')), feed)
    ).request('/feed', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(await decoded(res)).toBe('{"n":1}\n'.repeat(200))
  })
})

describe('compression() and validators', () => {
  const tagged = () =>
    new Router('/tagged').get('/').handler(ctx => {
      ctx.header('etag', '"v1"')
      ctx.header('accept-ranges', 'bytes')
      return PETS
    })

  it("keeps the route's strong tag on a compressed answer, and drops Accept-Ranges", async () => {
    const res = await (
      await serve(undefined, tagged())
    ).request('/tagged', {
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(res.headers.get('accept-ranges')).toBe(null)
  })

  it('keeps the strong tag and Accept-Ranges on an identity answer', async () => {
    const res = await (
      await serve(undefined, tagged())
    ).request('/tagged', {
      headers: { 'accept-encoding': 'identity' },
    })

    expect(res.headers.get('etag')).toBe('"v1"')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })
})

describe('compression() on HEAD', () => {
  it('says the coding a GET would carry, with no length and no body', async () => {
    const app = await serve(undefined)
    const get = await app.request('/pets', { headers: { 'accept-encoding': 'br' } })
    const head = await app.request('/pets', { method: 'HEAD', headers: { 'accept-encoding': 'br' } })

    expect(head.status).toBe(200)
    expect(head.headers.get('content-encoding')).toBe(get.headers.get('content-encoding'))
    expect(head.headers.get('content-encoding')).toBe('br')
    expect(head.headers.get('vary')).toBe('Accept-Encoding')
    expect(head.headers.get('content-length')).toBe(null)
    expect((await bytesOf(head)).byteLength).toBe(0)
  })

  it('closes the stream a HEAD handler returned', async () => {
    let cancelled!: () => void
    const closed = new Promise<void>(resolve => (cancelled = resolve))
    const streamed = new Router('/streamed').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return new ReadableStream<Uint8Array>({ pull: () => undefined, cancel: () => cancelled() })
    })
    const res = await (
      await serve(undefined, streamed)
    ).request('/streamed', {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    await closed
  })
})

describe('compression() on a stream', () => {
  it('compresses a web stream chunk by chunk, so the client reads the first before the second is written', async () => {
    const encoder = new TextEncoder()
    let release!: () => void
    const second = new Promise<void>(resolve => (release = resolve))
    const streamed = new Router('/streamed').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('first '))
          await second
          controller.enqueue(encoder.encode('second '))
          controller.enqueue(encoder.encode('third'))
          controller.close()
        },
      })
    })
    const res = await (
      await serve(undefined, streamed)
    ).request('/streamed', {
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('content-length')).toBe(null)

    const reader = res.body!.pipeThrough(new DecompressionStream('gzip')).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('first ')

    release()
    let rest = ''
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      rest += new TextDecoder().decode(next.value)
    }
    expect(rest).toBe('second third')
  })

  // Without a flush per chunk, the coder codes the whole as it would one buffer: the bytes are the one-shot coding's.
  it.each([
    ['gzip', (text: string) => gzipSync(text)],
    ['deflate', (text: string) => deflateSync(text)],
    ['br', (text: string) => brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })],
    ['zstd', undefined],
  ] as const)('codes a stream of declared length in %s as a whole, and drops its length', async (coding, oneShot) => {
    const chunks = Array.from({ length: 8 }, (_, i) => `chunk ${i} `.repeat(200))
    const text = chunks.join('')
    const sized = new Router('/sized').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain').header('content-length', String(Buffer.byteLength(text)))
      return Readable.toWeb(Readable.from(chunks.map(chunk => Buffer.from(chunk))))
    })
    const res = await (await serve(undefined, sized)).request('/sized', { headers: { 'accept-encoding': coding } })
    const body = await bytesOf(res)

    expect(res.headers.get('content-encoding')).toBe(coding)
    expect(res.headers.get('content-length')).toBe(null)
    expect(DECODE[coding](body).toString()).toBe(text)
    if (oneShot !== undefined) {
      expect(body).toEqual(oneShot(text))
    }
  })

  it('fails the coded answer when the stream fails, rather than end it as a whole body', async () => {
    const failing = new Router('/failing').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('first '.repeat(500)))
          controller.error(new Error('source gone'))
        },
      })
    })
    const res = await (await serve(undefined, failing)).request('/failing', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    await expect(res.arrayBuffer()).rejects.toThrow()
  })
})

describe('compression() per route', () => {
  const small = () => new Router('/small').get('/').handler(() => 'a'.repeat(100))

  it('leaves a route with compress(false) alone, without varying', async () => {
    const off = new Router('/off')
      .extend(compress(false))
      .get('/')
      .handler(() => PETS)
    const res = await (await serve(undefined, off)).request('/off', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe(null)
  })

  it("writes a route's settings over the plugin's", async () => {
    const zero = new Router('/zero')
      .extend(compress({ threshold: 0 }))
      .get('/')
      .handler(() => 'a'.repeat(100))
    const res = await (
      await serve(undefined, zero, small())
    ).request('/zero', {
      headers: { 'accept-encoding': 'gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(await decoded(res)).toBe('a'.repeat(100))
  })

  it('offers only the codings a route lists', async () => {
    const only = new Router('/only')
      .extend(compress({ encodings: ['gzip'] }))
      .get('/')
      .handler(() => PETS)
    const res = await (await serve(undefined, only)).request('/only', { headers: { 'accept-encoding': 'br, gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  it("lets a route's compress(true) turn compression back on under its router's compress(false)", async () => {
    const router = new Router('/mixed').extend(compress(false))
    router.get('/off').handler(() => PETS)
    router
      .get('/on')
      .extend(compress(true))
      .handler(() => PETS)
    const app = await serve(undefined, router)

    const off = await app.request('/mixed/off', { headers: { 'accept-encoding': 'gzip' } })
    const on = await app.request('/mixed/on', { headers: { 'accept-encoding': 'gzip' } })

    expect(off.headers.get('content-encoding')).toBe(null)
    expect(on.headers.get('content-encoding')).toBe('gzip')
  })

  it("compresses only a router's routes when registered on the router", async () => {
    const api = new Router('/api').with(compression())
    api.get('/').handler(() => PETS)
    const outside = new Router('/outside').get('/').handler(() => PETS)
    const built = createWebApplication().mount(api, outside)
    apps.push(built)
    await built.bootstrap()

    const inside = await built.request('/api', { headers: { 'accept-encoding': 'gzip' } })
    const other = await built.request('/outside', { headers: { 'accept-encoding': 'gzip' } })

    expect(inside.headers.get('content-encoding')).toBe('gzip')
    expect(other.headers.get('content-encoding')).toBe(null)
  })

  it('lets a fluent setter win over the block config(...) handed over', async () => {
    const res = await (
      await serve(c => c.config({ threshold: 4 * KiB }).threshold(10), small())
    ).request('/small', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  it('adds to a list with each call, as the encodings are preferred in the order written', async () => {
    const res = await (
      await serve(c => c.encodings('gzip').encodings('br'))
    ).request('/pets', {
      headers: { 'accept-encoding': 'br, gzip' },
    })

    expect(res.headers.get('content-encoding')).toBe('gzip')
  })
})

describe('two compression() over one route', () => {
  async function nested(api: AnyRouter, ...routers: AnyRouter[]) {
    const built = createWebApplication()
      .with(compression(c => c.encodings('br')))
      .mount(api, ...routers)
    apps.push(built)
    await built.bootstrap()
    return built
  }

  it("lets the router's, the innermost, choose the coding", async () => {
    const api = new Router('/api').with(compression(c => c.encodings('gzip')))
    api.get('/').handler(() => PETS)
    const built = await nested(api)

    const res = await built.request('/api', { headers: { 'accept-encoding': 'gzip, br' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(await decoded(res)).toBe(PETS_JSON)
  })

  it("leaves alone what the innermost leaves alone, whatever the server's would do", async () => {
    const api = new Router('/api').with(compression(c => c.threshold(8 * KiB)))
    api.get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return 'a'.repeat(4 * KiB)
    })
    const built = await nested(api)

    const res = await built.request('/api', { headers: { 'accept-encoding': 'gzip, br' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe(null)
    expect(await res.text()).toBe('a'.repeat(4 * KiB))
  })

  it("keeps the server's for a router without one of its own", async () => {
    const api = new Router('/api').with(compression(c => c.encodings('gzip')))
    api.get('/').handler(() => PETS)
    const built = await nested(api, pets())

    const res = await built.request('/pets', { headers: { 'accept-encoding': 'gzip, br' } })

    expect(res.headers.get('content-encoding')).toBe('br')
  })

  it('refuses a second compression() in one slot', async () => {
    const built = createWebApplication().with(compression()).with(compression()).mount(pets())
    apps.push(built)
    const failure = await built.bootstrap().then(
      () => undefined,
      (err: unknown) => err as Error,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect(failure!.message.split('\n')[0]).toBe(
      `Cannot register plugin "caffeine-compression" twice on the application's own server`,
    )
  })
})

describe("compression() coding at each builder method's setting", () => {
  it.each([
    ['gzip', (c: CompressionBuilder) => c.gzip({ level: 1 }), () => gzipSync(PETS_JSON, { level: 1 })],
    ['deflate', (c: CompressionBuilder) => c.deflate({ level: 9 }), () => deflateSync(PETS_JSON, { level: 9 })],
    [
      'br',
      (c: CompressionBuilder) => c.br({ quality: 0 }),
      () => brotliCompressSync(PETS_JSON, { params: { [constants.BROTLI_PARAM_QUALITY]: 0 } }),
    ],
    // An empty object sets nothing: the default level stands.
    ['deflate', (c: CompressionBuilder) => c.deflate({}), () => deflateSync(PETS_JSON, { level: 6 })],
  ] as const)('codes %s at the level its builder method sets', async (coding, configure, expected) => {
    const res = await (await serve(configure)).request('/pets', { headers: { 'accept-encoding': coding } })

    expect(res.headers.get('content-encoding')).toBe(coding)
    expect(await bytesOf(res)).toEqual(expected())
  })
})

// zstd tunes its parameters to the size it is told, and records it in the frame: a body coded off the calling thread
// is told its size as one coded on it is, and comes out the same.
describe('compression() coding a body off the calling thread in zstd', () => {
  it('codes it as the one-shot call does, its size in the frame', async () => {
    const text = Array.from({ length: 4 * KiB }, (_, i) => `line ${i % 97} of ${i % 13}\n`).join('')
    const large = new Router('/large').get('/').handler(() => text)
    const res = await (
      await serve(c => c.zstd({ level: 1 }), large)
    ).request('/large', { headers: { 'accept-encoding': 'zstd' } })

    expect(Buffer.byteLength(text)).toBeGreaterThan(16 * KiB)
    expect(res.headers.get('content-encoding')).toBe('zstd')
    expect(await bytesOf(res)).toEqual(zstdCompressSync(text, { params: { [constants.ZSTD_c_compressionLevel]: 1 } }))
  })
})

describe('compression() reading its settings once', () => {
  it('keeps the codings it was built with when the list handed to config(...) changes later', async () => {
    const list: ContentCoding[] = ['gzip']
    const app = await serve(c => c.config({ encodings: list }))
    list.push('br')

    const res = await app.request('/pets', { headers: { 'accept-encoding': 'br' } })

    expect(res.headers.get('content-encoding')).toBe(null)
  })

  // A later plugin's factory runs before routes are compiled, where a route's compress({...}) is resolved.
  it("resolves a route's compress({...}) against the settings it was built with, not a list changed later", async () => {
    class Noop extends HTTPPlugin {
      register(): void {}
    }
    const list: ContentCoding[] = ['gzip']
    const zero = new Router('/zero')
      .extend(compress({ threshold: 0 }))
      .get('/')
      .handler(() => 'a'.repeat(100))
    const app = createWebApplication()
      .with(compression(c => c.config({ encodings: list })))
      .with(() => {
        list.splice(0, list.length, 'br')
        return new Noop()
      })
      .mount(pets(), zero)
    apps.push(app)
    await app.bootstrap()

    const ordinary = await app.request('/pets', { headers: { 'accept-encoding': 'gzip' } })
    const overridden = await app.request('/zero', { headers: { 'accept-encoding': 'gzip' } })

    expect(ordinary.headers.get('content-encoding')).toBe('gzip')
    expect(overridden.headers.get('content-encoding')).toBe('gzip')
  })
})

describe('compression() refusing settings at start-up', () => {
  async function refusal(build: () => Promise<unknown>): Promise<string> {
    const failure = await build().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(ErrConfiguration)
    return (failure as Error).message.split('\n')[0]!
  }

  const withConfig = (config: object) => () => serve(c => c.config(config as never))

  it.each([
    ['gzip', (c: CompressionBuilder) => c.gzip({ level: 10 }), '"gzip.level" must be a whole number from 1 to 9'],
    [
      'deflate',
      (c: CompressionBuilder) => c.deflate({ level: 0 }),
      '"deflate.level" must be a whole number from 1 to 9',
    ],
    ['br', (c: CompressionBuilder) => c.br({ quality: 12 }), '"br.quality" must be a whole number from 0 to 11'],
  ] as const)('refuses a %s setting out of its range given to its builder method', async (_, configure, reason) => {
    expect(await refusal(() => serve(configure))).toBe(`Cannot build compression(): ${reason}`)
  })

  it("refuses a route's compress({ encodings: [] }), and tells it to turn compression off instead", async () => {
    const route = new Router('/r')
      .extend(compress({ encodings: [] }))
      .get('/')
      .handler(() => 'r')
    const failure = await serve(undefined, route).then(
      () => undefined,
      (err: unknown) => err as Error,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect(failure!.message.split('\n')[0]).toBe('Cannot serve "GET /r": "encodings" lists no coding')
    expect(failure!.message).toContain('Write compress(false) to turn compression off for the route')
  })

  it('refuses encodings() called with no coding after one with codings: the call empties the list', async () => {
    expect(await refusal(() => serve(c => c.encodings('gzip').encodings()))).toBe(
      'Cannot build compression(): "encodings" lists no coding',
    )
  })

  it.each([
    [{ encodings: [] }, 'Cannot build compression(): "encodings" lists no coding'],
    [{ encodings: ['lzma'] }, 'Cannot build compression(): "lzma" is not a content coding'],
    [{ encodings: ['gzip', 'gzip'] }, 'Cannot build compression(): "gzip" is listed twice in "encodings"'],
    [{ encodings: 'gzip' }, 'Cannot build compression(): "encodings" must be a list of codings'],
    [{ gzip: { level: 10 } }, 'Cannot build compression(): "gzip.level" must be a whole number from 1 to 9'],
    [{ deflate: { level: 0 } }, 'Cannot build compression(): "deflate.level" must be a whole number from 1 to 9'],
    [{ br: { quality: -1 } }, 'Cannot build compression(): "br.quality" must be a whole number from 0 to 11'],
    [{ zstd: { level: 20 } }, 'Cannot build compression(): "zstd.level" must be a whole number from 1 to 19'],
    [{ gzip: { quality: 5 } }, 'Cannot build compression(): "gzip" takes { level } alone'],
    [{ threshold: -1 }, 'Cannot build compression(): "threshold" must be a size in bytes'],
    [{ threshold: 1.5 }, 'Cannot build compression(): "threshold" must be a size in bytes'],
    [{ level: 5 }, 'Cannot build compression(): "level" is not a compression setting'],
    [{ compressible: 'text/*' }, 'Cannot build compression(): "compressible" must be a function of the content type'],
  ])('refuses %j', async (config, message) => {
    expect(await refusal(withConfig(config))).toBe(message)
  })

  it("names only a route's own settings when refusing an unknown one on a route", async () => {
    const route = new Router('/r')
      .extend(compress({ levle: 9 } as never))
      .get('/')
      .handler(() => 'r')
    const failure = await serve(undefined, route).then(
      () => undefined,
      (err: unknown) => err as Error,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect(failure!.message).toContain('Cannot serve "GET /r": "levle" is not a compression setting')
    expect(failure!.message.split('\n')).toContain(
      '  - Use encodings, threshold, gzip, deflate, br, zstd, compressible',
    )
  })

  it("refuses a route's compress(...) that is neither an object nor a boolean", async () => {
    const route = new Router('/r')
      .extend(compress('gzip' as never))
      .get('/')
      .handler(() => 'r')

    expect(await refusal(() => serve(undefined, route))).toBe(
      'Cannot serve "GET /r": its compression setting must be an object or a boolean',
    )
  })

  it("refuses a route's settings out of range", async () => {
    const route = new Router('/r')
      .extend(compress({ gzip: { level: 12 } }))
      .get('/')
      .handler(() => 'r')

    expect(await refusal(() => serve(undefined, route))).toBe(
      'Cannot serve "GET /r": "gzip.level" must be a whole number from 1 to 9',
    )
  })
})

describe('compression() under node()', () => {
  async function listen(...routers: AnyRouter[]): Promise<string> {
    const built = createWebApplication({ adapter: node() })
      .with(compression())
      .mount(pets(), ...routers)
    apps.push(built)
    const { address } = await built.run({ host: '127.0.0.1', port: 0 })
    return `http://127.0.0.1:${address!.port}`
  }

  it('compresses a Node stream the handler returned', async () => {
    const node = new Router('/node').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      return Readable.from(['one ', 'two ', 'three'])
    })
    const origin = await listen(node)
    const res = await send(origin, '/node', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['transfer-encoding']).toBe('chunked')
    expect(gunzipSync(res.body).toString()).toBe('one two three')
  })
})
