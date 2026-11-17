import { $t } from '@caffeinejs/application/schema'
import { Byte } from '@caffeinejs/std/bytes'
import { Second } from '@caffeinejs/std/duration'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createWebApplication, type WebApplication } from '../../application.js'
import { bodyAsBuffer } from '../../decorators/body_as_buffer.js'
import { bodyAsStream } from '../../decorators/body_as_stream.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { ServerSettings } from './settings.js'

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>
type FetchApp = WebApplication<any, any, any>

let app: FetchApp | undefined

afterEach(async () => {
  vi.useRealTimers()
  await app?.close()
  app = undefined
})

async function serve(router: AnyRouter, settings: ServerSettings = {}): Promise<FetchApp> {
  app = createWebApplication()
    .server(() => settings)
    .mount(router)
  await app.bootstrap()
  return app
}

function post(served: FetchApp, path: string, body: RequestInit['body'], headers: Record<string, string> = {}) {
  return served.fetch(new Request(`http://localhost${path}`, { method: 'POST', body, headers }))
}

function json(served: FetchApp, path: string, value: unknown) {
  return post(served, path, JSON.stringify(value), { 'content-type': 'application/json' })
}

async function problem(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

/** A body of `size` bytes, its stream pulled only when read: `pulled` says whether anything read it. */
function counted(size: number): { stream: ReadableStream<Uint8Array>; pulled: () => boolean } {
  let pulled = false
  return {
    pulled: () => pulled,
    // No high-water mark: a stream fills its queue as soon as it is built otherwise.
    stream: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true
          controller.enqueue(new Uint8Array(size))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    ),
  }
}

function streamed(served: FetchApp, path: string, stream: ReadableStream<Uint8Array>, headers: Record<string, string>) {
  return served.fetch(
    new Request(`http://localhost${path}`, { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit),
  )
}

describe('reading the body', () => {
  it('hands the handler the parsed JSON body', async () => {
    const served = await serve(new Router('/b').post('/').handler(ctx => ({ got: ctx.req.body() })))

    expect(await (await json(served, '/b', { a: 1 })).json()).toEqual({ got: { a: 1 } })
  })

  it('holds a body to the server bodyLimit, answering 413 past it', async () => {
    const served = await serve(
      new Router('/b').post('/').handler(() => 'ok'),
      { bodyLimit: 10 * Byte },
    )

    const res = await post(served, '/b', 'x'.repeat(11), { 'content-type': 'text/plain' })

    expect(res.status).toBe(413)
    expect((await problem(res)).code).toBe('ERR_HTTP_CONTENT_TOO_LARGE')
  })

  it("lets a route's bodyLimit win over the server's", async () => {
    const router = new Router('/b')
      .post('/')
      .bodyLimit(100 * Byte)
      .handler(ctx => ctx.req.body())
    const served = await serve(router, { bodyLimit: 10 * Byte })

    const res = await post(served, '/b', 'x'.repeat(50), { 'content-type': 'text/plain' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('x'.repeat(50))
  })

  // Refused from the header: a client cannot make the server read what it already said is too much.
  it('answers 413 to a declared Content-Length over the limit without reading the body', async () => {
    const served = await serve(
      new Router('/b').post('/').handler(() => 'ok'),
      { bodyLimit: 10 * Byte },
    )
    const body = counted(11)

    const res = await streamed(served, '/b', body.stream, { 'content-type': 'text/plain', 'content-length': '11' })

    expect(res.status).toBe(413)
    expect(body.pulled()).toBe(false)
  })

  it.each([1.5, 0, -1, Number.NaN, '1kb'])('fails bootstrap() for a route bodyLimit of %o', async limit => {
    const router = new Router('/bad')
      .post('/')
      .bodyLimit(limit as number)
      .handler(() => 'ok')
    app = createWebApplication().mount(router)

    await expect(app.bootstrap()).rejects.toThrow('is not a whole number of bytes above 0')
  })

  // A GET or HEAD body is never read, so a schema for it would refuse every request: refused where Fastify refuses it.
  it('fails bootstrap() for a body schema on a route whose method carries no body', async () => {
    const router = new Router('/g')
      .get('/')
      .schema({ body: $t.Object({ a: $t.String() }) })
      .handler(() => 'ok')
    app = createWebApplication().mount(router)

    await expect(app.bootstrap()).rejects.toThrow('its method GET carries no body')
  })

  it('answers 415 to a media type no parser reads', async () => {
    const served = await serve(new Router('/b').post('/').handler(() => 'ok'))

    const res = await post(served, '/b', '<a/>', { 'content-type': 'application/xml' })

    expect(res.status).toBe(415)
    expect((await problem(res)).code).toBe('ERR_HTTP_UNSUPPORTED_MEDIA_TYPE')
  })

  it('answers 415 to a body that names no Content-Type', async () => {
    const served = await serve(new Router('/b').post('/').handler(() => 'ok'))

    const res = await post(served, '/b', new Uint8Array([1, 2, 3]))

    expect(res.status).toBe(415)
  })

  it('reads no body when the request names no Content-Type and carries none', async () => {
    const served = await serve(new Router('/b').post('/').handler(ctx => ({ body: ctx.req.body() ?? null })))

    const res = await post(served, '/b', null)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: null })
  })

  it('answers 400 to a QUERY request without a Content-Type', async () => {
    const served = await serve(new Router('/q').query('/', {}, () => 'ok'))

    // Bytes, as a string body would be given a text/plain type.
    const res = await served.fetch(
      new Request('http://localhost/q', { method: 'QUERY', body: new Uint8Array([123, 125]) }),
    )

    expect(res.status).toBe(400)
  })

  it('never reads the body of a GET', async () => {
    const served = await serve(new Router('/b').get('/').handler(ctx => ({ body: ctx.req.body() ?? null })))

    const res = await served.fetch(
      new Request('http://localhost/b', { headers: { 'content-type': 'application/json' } }),
    )

    expect(await res.json()).toEqual({ body: null })
  })
})

describe('@BodyAsBuffer and @BodyAsStream', () => {
  it('hands a @BodyAsBuffer route the bytes, whatever their type', async () => {
    const router = new Router('/raw')
      .post('/')
      .extend(bodyAsBuffer())
      .handler(ctx => Array.from(ctx.req.body() as Uint8Array))
    const served = await serve(router)

    const res = await post(served, '/raw', new Uint8Array([7, 8, 9]), { 'content-type': 'application/octet-stream' })

    expect(await res.json()).toEqual([7, 8, 9])
  })

  it('holds a @BodyAsBuffer body to the limit', async () => {
    const router = new Router('/raw')
      .post('/')
      .extend(bodyAsBuffer())
      .handler(() => 'ok')
    const served = await serve(router, { bodyLimit: 2 * Byte })

    const res = await post(served, '/raw', new Uint8Array([1, 2, 3]), { 'content-type': 'application/octet-stream' })

    expect(res.status).toBe(413)
  })

  it('hands a @BodyAsStream route a stream that fails with a 413 past the limit', async () => {
    const outcome = Promise.withResolvers<number>()
    const router = new Router('/raw')
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => {
        try {
          await new Response(ctx.req.body() as ReadableStream<Uint8Array>).arrayBuffer()
          outcome.resolve(200)
        } catch (err) {
          outcome.resolve((err as { statusCode: number }).statusCode)
        }
        return 'done'
      })
    const served = await serve(router, { bodyLimit: 2 * Byte })

    await streamed(served, '/raw', counted(3).stream, { 'content-type': 'application/octet-stream' })

    expect(await outcome.promise).toBe(413)
  })

  it('answers 413 to a @BodyAsStream request declaring too much, before its handler', async () => {
    const handled = vi.fn(() => 'ok')
    const router = new Router('/raw').post('/').extend(bodyAsStream()).handler(handled)
    const served = await serve(router, { bodyLimit: 2 * Byte })

    const res = await streamed(served, '/raw', counted(3).stream, {
      'content-type': 'application/octet-stream',
      'content-length': '3',
    })

    expect(res.status).toBe(413)
    expect(handled).toHaveBeenCalledTimes(0)
  })

  it('fails bootstrap() for a body schema on a route that reads its own body', async () => {
    const router = new Router('/raw')
      .post('/')
      .extend(bodyAsStream())
      .schema({ body: $t.Object({ a: $t.String() }) })
      .handler(() => 'ok')
    app = createWebApplication().mount(router)

    await expect(app.bootstrap()).rejects.toThrow('its body schema needs a parsed body')
  })

  it('boots a @BodyAsStream route whose $t.File() body documents the upload', async () => {
    const router = new Router('/raw')
      .post('/')
      .extend(bodyAsStream())
      .schema({ body: $t.File() })
      .handler(() => 'ok')
    const served = await serve(router)

    const res = await post(served, '/raw', 'abc', { 'content-type': 'application/octet-stream' })

    expect(res.status).toBe(200)
  })
})

describe('validating the request', () => {
  const pets = new Router('/pets')
    .post('/:id')
    .schema({
      params: $t.Object({ id: $t.Integer() }),
      querystring: $t.Object({ page: $t.Integer({ default: 1 }) }),
      body: $t.Object({ name: $t.String({ minLength: 1 }) }),
    })
    .handler(ctx => ({
      id: ctx.req.param('id') as unknown,
      page: ctx.req.query().page,
      body: ctx.req.body(),
    }))

  it('hands the handler what validation produced: converted, defaulted, undeclared body keys dropped', async () => {
    const served = await serve(pets)

    const res = await json(served, '/pets/7', { name: 'rex', owner: 'x' })

    expect(await res.json()).toEqual({ id: 7, page: 1, body: { name: 'rex' } })
  })

  it('answers 422 to a body that fails its schema, naming the rule and where', async () => {
    const served = await serve(pets)

    const res = await json(served, '/pets/7', { name: '' })
    const body = await problem(res)

    expect(res.status).toBe(422)
    expect((body.errors as unknown[])[0]).toMatchObject({
      code: 'ERR_VALIDATION_MIN_LENGTH',
      source: { in: 'body', pointer: '/name' },
    })
  })

  it('answers 400 to a query that fails its schema', async () => {
    const served = await serve(pets)

    const res = await json(served, '/pets/7?page=x', { name: 'rex' })

    expect(res.status).toBe(400)
    expect((await problem(res)).detail).toBe('Invalid query string')
  })

  // Fastify's order: params, body, querystring, headers.
  it('names the path parameters when both they and the body fail', async () => {
    const served = await serve(pets)

    const res = await json(served, '/pets/x', { name: '' })

    expect(res.status).toBe(400)
    expect((await problem(res)).detail).toBe('Invalid path parameters')
  })

  // A failure leaves the request as it came: what an onError hook or a catch handler reads is what the client sent.
  it('leaves the query as sent when it fails its schema', async () => {
    let seen: unknown
    const router = new Router('/q')
      .get('/')
      .schema({
        querystring: {
          ...$t.Object({ page: $t.Integer(), q: $t.String({ minLength: 3 }) }),
          additionalProperties: false,
        },
      })
      .hook('onError', ctx => void (seen = { ...ctx.req.query() }))
      .handler(() => 'ok')
    const served = await serve(router)

    const res = await served.fetch(new Request('http://localhost/q?page=2&extra=x&q=a'))

    expect(res.status).toBe(400)
    expect(seen).toEqual({ page: '2', extra: 'x', q: 'a' })
  })

  // A guard or a plugin may look up a name the client chose: validation must not make Object.prototype answer it.
  it('answers no header and no parameter for a name only Object.prototype holds', async () => {
    const router = new Router('/h')
      .get('/:id')
      .schema({ params: $t.Object({ id: $t.Integer() }), headers: $t.Object({ 'x-a': $t.String() }) })
      .handler(ctx => ({
        hasToString: ctx.req.hasHeader('toString'),
        header: typeof ctx.req.header('constructor'),
        param: typeof ctx.req.param('constructor'),
      }))
    const served = await serve(router)

    const res = await served.fetch(new Request('http://localhost/h/1', { headers: { 'x-a': '1' } }))

    expect(await res.json()).toEqual({ hasToString: false, header: 'undefined', param: 'undefined' })
  })

  it("hands the handler a Zod slot's transformed value", async () => {
    const router = new Router('/z')
      .get('/')
      .schema({ querystring: z.object({ n: z.string().transform(s => s.length) }) })
      .handler(ctx => ({ n: ctx.req.query().n }))
    const served = await serve(router)

    expect(await (await served.fetch(new Request('http://localhost/z?n=abc'))).json()).toEqual({ n: 3 })
  })

  it('waits for a Standard Schema that validates asynchronously', async () => {
    const later: StandardSchemaV1<unknown, { ok: boolean }> = {
      '~standard': { version: 1, vendor: 'test', validate: () => Promise.resolve({ value: { ok: true } }) },
    }
    const router = new Router('/a')
      .post('/')
      .schema({ body: later })
      .handler(ctx => ctx.req.body())
    const served = await serve(router)

    expect(await (await json(served, '/a', {})).json()).toEqual({ ok: true })
  })

  it('keeps the headers a Zod headers slot does not declare', async () => {
    const router = new Router('/h')
      .get('/')
      .schema({ headers: z.object({ 'x-a': z.string() }) })
      .handler(ctx => ({ host: ctx.req.header('host') ?? null, a: ctx.req.header('x-a') }))
    const served = await serve(router)

    const res = await served.fetch(new Request('http://localhost/h', { headers: { host: 'example.test', 'x-a': '1' } }))

    expect(await res.json()).toEqual({ host: 'example.test', a: '1' })
  })

  it('matches a TypeBox header named in any case, converted to its type', async () => {
    const router = new Router('/h')
      .get('/')
      .schema({ headers: $t.Object({ 'X-Page': $t.Number() }) })
      .handler(ctx => ({ page: ctx.req.header('x-page') as unknown }))
    const served = await serve(router)

    const res = await served.fetch(new Request('http://localhost/h', { headers: { 'x-page': '2' } }))

    expect(await res.json()).toEqual({ page: 2 })
  })

  it('matches a TypeBox header named in a union member', async () => {
    const router = new Router('/h')
      .get('/')
      .schema({ headers: $t.Union([$t.Object({ 'X-Page': $t.Number() }), $t.Object({ 'X-Id': $t.String() })]) })
      .handler(ctx => ({ page: ctx.req.header('x-page') as unknown }))
    const served = await serve(router)

    const res = await served.fetch(new Request('http://localhost/h', { headers: { 'x-page': '2' } }))

    expect(await res.json()).toEqual({ page: 2 })
  })

  it('decodes a codec: a $t.Duration() query of "5s" reaches the handler as 5000', async () => {
    const router = new Router('/d')
      .get('/')
      .schema({ querystring: $t.Object({ ttl: $t.Duration() }) })
      .handler(ctx => ({ ttl: ctx.req.query().ttl }))
    const served = await serve(router)

    expect(await (await served.fetch(new Request('http://localhost/d?ttl=5s'))).json()).toEqual({ ttl: 5000 })
  })

  // A slow body counts toward the timeout: reading it is part of serving the request.
  it('answers 503 when the body has not arrived within the handler timeout', async () => {
    const served = await serve(
      new Router('/b').post('/').handler(() => 'ok'),
      { handlerTimeout: 1 * Second },
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const held = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) })

    const answer = streamed(served, '/b', held, { 'content-type': 'text/plain' })
    await vi.advanceTimersByTimeAsync(1 * Second)
    const res = await answer

    expect(res.status).toBe(503)
    expect((await problem(res)).code).toBe('ERR_HTTP_SERVICE_UNAVAILABLE')
  })
})
