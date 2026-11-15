import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { newNoopLogger } from '@caffeinejs/application/logger'
import { $t } from '@caffeinejs/application/schema'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import { ErrResponseBodyConsumed } from '../../index.js'
import { Responder } from '../../response.js'
import { ErrHTTPUnprocessableContent } from '../error/http.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { IRoute } from '../routing/route.js'
import type { SchemaCompiler } from '../validation/validation.js'
import { compileSerializers, NO_SERIALIZER } from './answer.js'
import type { Context } from './context.js'

const PLAIN = 'region,total\nnorth,12\n'.repeat(40)

const routes = new Router('/a')
routes.get('/text').handler(() => 'hello')
routes.get('/object').handler(() => ({ a: 1 }))
routes.get('/number').handler(() => 3)
routes.get('/true').handler(() => true)
routes.get('/null').handler(() => null)
routes
  .get('/hal')
  .produces('application/hal+json')
  .handler(() => ({ a: 1 }))
routes
  .get('/object-as-csv')
  .produces('text/csv')
  .handler(() => ({ a: 1 }))
routes
  .get('/null-as-csv')
  .produces('text/csv')
  .handler(() => null)
routes.get('/bytes').handler(() => new Uint8Array([1, 2, 3]))
routes.get('/buffer').handler(() => new Uint8Array([1, 2, 3]).buffer)
routes.get('/blob').handler(() => new Blob(['abc'], { type: 'text/csv' }))
routes.get('/web-stream').handler(
  () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'))
        controller.enqueue(new TextEncoder().encode('b'))
        controller.close()
      },
    }),
)
routes.get('/node-stream').handler(() => Readable.from(['a', 'b']))
routes.get('/response').handler(
  () =>
    new Response('made', {
      status: 201,
      headers: { 'content-type': 'text/x-made', 'x-made': '1', connection: 'x-hop', 'x-hop': '1' },
    }),
)
routes.get('/upstream').handler(() => fetch(`${upstreamOrigin}/gzip`))
routes.get('/read-response').handler(async () => {
  const res = new Response('once')
  await res.text()
  return res
})
routes.get('/responder').handler(
  () =>
    new (class extends Responder {
      respond() {
        return { from: 'responder' }
      }
    })(),
)
routes.get('/body-then-value').handler(ctx => {
  ctx.body('from ctx')
  return 'from return'
})

const logged = vi.fn()
const app = createWebApplication()
  .logger(b => b.use({ ...newNoopLogger(), error: logged }))
  .mount(routes)

let upstream: Server
let upstreamOrigin: string

beforeAll(async () => {
  upstream = createServer((_req, res) => {
    const body = gzipSync(Buffer.from(PLAIN))
    res.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'gzip', 'content-length': body.length })
    res.end(body)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
  await new Promise(resolve => upstream.close(resolve))
})

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost/a${path}`))
}

describe('answer shaping', () => {
  it('sends a string as text/plain', async () => {
    const res = await get('/text')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('hello')
  })

  it.each([
    ['/object', '{"a":1}'],
    ['/number', '3'],
    ['/true', 'true'],
    ['/null', 'null'],
  ])('sends %s as JSON', async (path, body) => {
    const res = await get(path)

    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.text()).toBe(body)
  })

  it('adds the charset to a JSON type the route named', async () => {
    expect((await get('/hal')).headers.get('content-type')).toBe('application/hal+json; charset=utf-8')
  })

  // Fastify refuses to guess how an object goes out as CSV: the handler's bug, answered as a 500.
  it('refuses an object under a type that is not JSON', async () => {
    const res = await get('/object-as-csv')

    expect(res.status).toBe(500)
    expect(((await res.json()) as { code: string }).code).toBe('ERR_INTERNAL')
  })

  it('sends null under a type that is not JSON as an empty body', async () => {
    const res = await get('/null-as-csv')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it.each(['/bytes', '/buffer'])('sends %s as octet-stream with its length', async path => {
    const res = await get(path)

    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-length')).toBe('3')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('streams a Blob under its type and size', async () => {
    const res = await get('/blob')

    expect(res.headers.get('content-type')).toBe('text/csv')
    expect(res.headers.get('content-length')).toBe('3')
    expect(await res.text()).toBe('abc')
  })

  // A Response reads only bytes, and a Node stream of strings is what `Readable.from` makes.
  it.each(['/web-stream', '/node-stream'])('streams %s as bytes', async path => {
    const res = await get(path)

    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-length')).toBe(null)
    expect(await res.text()).toBe('ab')
  })

  it('takes a Response apart: status, headers and body, less the fields that describe its connection', async () => {
    const res = await get('/response')

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('text/x-made')
    expect(res.headers.get('x-made')).toBe('1')
    expect(res.headers.get('x-hop')).toBe(null)
    expect(await res.text()).toBe('made')
  })

  // `fetch` decoded the body: its coding and its encoded length no longer describe it.
  it('drops content-encoding from a body fetch decoded', async () => {
    const res = await get('/upstream')

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(await res.text()).toBe(PLAIN)
  })

  // The class is the package's, so an application can catch it by name.
  it('answers 500 for a Response whose body was read, failing with ErrResponseBodyConsumed', async () => {
    logged.mockClear()

    expect((await get('/read-response')).status).toBe(500)
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(ErrResponseBodyConsumed) }),
      expect.any(String),
    )
  })

  it('unwraps a Responder once and sends what it returned', async () => {
    expect(await (await get('/responder')).json()).toEqual({ from: 'responder' })
  })

  it('sends nothing more once the handler answered through ctx and returned a value', async () => {
    expect(await (await get('/body-then-value')).text()).toBe('from ctx')
  })
})

describe('compileSerializers', () => {
  // Each serializer writes the key it was compiled for, so a lookup names the schema it picked.
  const compiler: SchemaCompiler = {
    validator: () => {
      throw new Error('not used')
    },
    serializer:
      ({ context }) =>
      () =>
        context,
  }
  const route = (response: Record<string, unknown> | undefined) =>
    ({ schema: response === undefined ? undefined : { response } }) as unknown as IRoute<Context>

  it('picks the exact status, then its class in any case, then default', () => {
    const lookup = compileSerializers(route({ 201: {}, '4XX': {}, default: {} }), 'GET /x', compiler)

    expect(lookup(201)?.(null)).toBe('GET /x response 201')
    expect(lookup(404)?.(null)).toBe('GET /x response 4xx')
    expect(lookup(500)?.(null)).toBe('GET /x response default')
  })

  it('has no serializer for a status no key covers', () => {
    expect(compileSerializers(route({ 200: {} }), 'GET /x', compiler)(500)).toBe(undefined)
  })

  it('compiles nothing for a route without response schemas', () => {
    expect(compileSerializers(route(undefined), 'GET /x', compiler)).toBe(NO_SERIALIZER)
  })
})

describe("writing an answer with the route's response schema", () => {
  // A fetch application of its own per route, closed once the test has read its answer.
  async function answerOf(router: Router<any, any, any, any, any, any>): Promise<Response> {
    const served = createWebApplication().mount(router)
    await served.bootstrap()
    try {
      const res = await served.fetch(new Request('http://localhost/r'))
      return new Response(await res.text(), { status: res.status })
    } finally {
      await served.close()
    }
  }

  it('sends declared members only, with codecs encoded', async () => {
    const router = new Router('/r')
      .get('/')
      .schema({ response: { 200: $t.Object({ ttl: $t.Duration() }) } })
      .handler(() => ({ ttl: 5000, secret: 'x' }))

    expect(await (await answerOf(router)).text()).toBe('{"ttl":"5s"}')
  })

  it('writes an answer of 201 with the schema of its class, 2xx', async () => {
    const router = new Router('/r')
      .get('/')
      .schema({ response: { '2xx': $t.Object({ a: $t.Number() }) } })
      .handler(ctx => {
        ctx.status(201)
        return { a: 1, b: 2 }
      })
    const res = await answerOf(router)

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('{"a":1}')
  })

  it("writes an ErrHTTP's body with the schema of its status", async () => {
    const router = new Router('/r')
      .get('/')
      .schema({ response: { 422: $t.Object({ a: $t.Number() }) } })
      .handler(() => {
        throw new ErrHTTPUnprocessableContent('no', { body: { a: 1, extra: 2 } })
      })
    const res = await answerOf(router)

    expect(res.status).toBe(422)
    expect(await res.text()).toBe('{"a":1}')
  })

  it('writes an answer with the default schema when no status names one', async () => {
    const router = new Router('/r')
      .get('/')
      .schema({ response: { default: $t.Object({ a: $t.Number() }) } })
      .handler(ctx => {
        ctx.status(500)
        return { a: 1, b: 2 }
      })
    expect(await (await answerOf(router)).text()).toBe('{"a":1}')
  })

  it('sends a string the handler returns as it is', async () => {
    const router = new Router('/r')
      .get('/')
      .schema({ response: { 200: $t.Object({ a: $t.Number() }) } })
      .handler(() => 'plain')
    expect(await (await answerOf(router)).text()).toBe('plain')
  })
})
