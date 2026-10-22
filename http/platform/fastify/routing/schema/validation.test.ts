import { $t } from '@caffeinejs/application/schema'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { WebApplication } from '../../../../application.js'
import { createWebApplication } from '../../application.js'
import { newRouter } from '../new_router.js'
import { fst } from '../route_options.js'

// Widened: `mount()` re-types the application with the routes it took, and the holder outlives the call.
let app: WebApplication<any, any, any, any> | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function serve(
  router: { readonly __routes?: unknown },
  configure: (app: WebApplication<any, any, any, any>) => WebApplication<any, any, any, any> = it => it,
): Promise<WebApplication<any, any, any, any>> {
  app = configure(createWebApplication()).mount(router as never)
  await app.bootstrap()
  return app
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('a route whose schema holds a codec', () => {
  // The handler is typed with the decoded value, so it must be handed the decoded value: a span in milliseconds and a
  // list, not the text they were written as.
  it('hands the handler the decoded query', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ querystring: $t.Object({ timeout: $t.Duration(), tags: $t.Optional($t.List($t.String())) }) })
      .handler(ctx => ({ query: ctx.req.query() }))

    const res = await (await serve(jobs)).fetch('/jobs?timeout=5s&tags=a,b')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ query: { timeout: 5000, tags: ['a', 'b'] } })
  })

  // Caffeine validates the route, so a value its codec cannot read must still answer as a validation failure does.
  it('answers 400 with the error Fastify raises for text a codec cannot read', async () => {
    const db = newRouter('/db')
      .get('/')
      .schema({ querystring: $t.Object({ db: $t.JSON($t.Object({ host: $t.String() })) }) })
      .handler(ctx => ({ query: ctx.req.query() }))

    const res = await (await serve(db)).fetch('/db?db=%7Bnot-json')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      error: 'Bad Request',
      message: 'querystring/db The value is not valid JSON',
    })
  })

  // An open query string keeps what a plugin, or `ctx.req.query(key)`, may read.
  it('keeps the query keys the schema does not declare', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ querystring: $t.Object({ timeout: $t.Duration() }) })
      .handler(ctx => ({ query: ctx.req.query() }))

    const res = await (await serve(jobs)).fetch('/jobs?timeout=5s&trace=on')

    expect(await res.json()).toEqual({ query: { timeout: 5000, trace: 'on' } })
  })

  // A closed body is mass-assignment protection: a field the client invented never reaches the handler.
  it('drops the body keys the schema does not declare', async () => {
    const jobs = newRouter('/jobs')
      .post('/')
      .schema({ body: $t.Object({ ttl: $t.Duration() }) })
      .handler(ctx => ({ body: ctx.req.body() }))

    const res = await (await serve(jobs)).fetch('/jobs', json({ ttl: '1m', admin: true }))

    expect(await res.json()).toEqual({ body: { ttl: 60000 } })
  })

  // As Ajv's `removeAdditional`: the closed body loses its own extra keys, and a nested object loses them only when it
  // forbids them. A codec in the route must not change which data the handler gets.
  it('drops a nested key only where its object forbids undeclared ones', async () => {
    const jobs = newRouter('/jobs')
      .post('/')
      .schema({
        body: $t.Object({
          ttl: $t.Duration(),
          open: $t.Object({ a: $t.String() }),
          closed: $t.Object({ a: $t.String() }, { additionalProperties: false }),
        }),
      })
      .handler(ctx => ({ body: ctx.req.body() }))

    const res = await (
      await serve(jobs)
    ).fetch('/jobs', json({ ttl: '1m', open: { a: 'x', more: 1 }, closed: { a: 'y', more: 2 }, admin: true }))

    expect(await res.json()).toEqual({ body: { ttl: 60000, open: { a: 'x', more: 1 }, closed: { a: 'y' } } })
  })

  it('keeps the body keys of a body authored open, and drops the query keys of a query authored closed', async () => {
    const jobs = newRouter('/jobs')
      .post('/')
      .schema({
        querystring: $t.Object({ timeout: $t.Duration() }, { additionalProperties: false }),
        body: $t.Object({ ttl: $t.Duration() }, { additionalProperties: true }),
      })
      .handler(ctx => ({ query: ctx.req.query(), body: ctx.req.body() }))

    const res = await (await serve(jobs)).fetch('/jobs?timeout=5s&trace=on', json({ ttl: '1m', note: 'kept' }))

    expect(await res.json()).toEqual({ query: { timeout: 5000 }, body: { ttl: 60000, note: 'kept' } })
  })

  // Node delivers header names lower-cased, and the headers a request always carries are not the schema's to drop.
  it('matches a header named in mixed case, and leaves the other headers in place', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ headers: $t.Object({ 'X-Tags': $t.List($t.String()) }) })
      .handler(ctx => {
        const headers = ctx.req.header() as unknown as Record<string, unknown>
        return { tags: headers['x-tags'], host: ctx.req.hasHeader('host') }
      })

    const res = await (await serve(jobs)).fetch('/jobs', { headers: { 'x-tags': 'a,b' } })

    expect(await res.json()).toEqual({ tags: ['a', 'b'], host: true })
  })

  it('flags the request instead of answering 400 when the route attaches validation errors', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .extend(fst({ attachValidation: true }))
      .schema({ querystring: $t.Object({ timeout: $t.Duration() }) })
      .handler(ctx => {
        const { validationError } = ctx.platform.request as { validationError?: Error }
        return { invalid: validationError?.message }
      })

    const res = await (await serve(jobs)).fetch('/jobs?timeout=forever')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invalid: expect.stringMatching(/^querystring\/timeout /) })
  })

  // Fastify stops at the first slot that fails, so the attached error is that slot's, not a later one's.
  it('attaches the error of the first slot that fails', async () => {
    const jobs = newRouter('/jobs')
      .post('/')
      .extend(fst({ attachValidation: true }))
      .schema({ querystring: $t.Object({ timeout: $t.Duration() }), body: $t.Object({ ttl: $t.Duration() }) })
      .handler(ctx => {
        const { validationError } = ctx.platform.request as { validationError?: { validationContext?: string } }
        return { context: validationError?.validationContext }
      })

    const res = await (await serve(jobs)).fetch('/jobs?timeout=forever', json({ ttl: 'forever' }))

    expect(await res.json()).toEqual({ context: 'body' })
  })

  // As Fastify does: the formatter is called on the server, and the status and code it sets are the ones that answer.
  it("keeps the status the server's schemaErrorFormatter sets, and calls it on the server", async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ querystring: $t.Object({ timeout: $t.Duration() }) })
      .handler(ctx => ({ query: ctx.req.query() }))
    const formatted = (it: WebApplication<any, any, any, any>) =>
      it.server(() => ({
        factory: {
          schemaErrorFormatter: function (this: { log?: unknown }) {
            return Object.assign(new Error(this.log === undefined ? 'unbound' : 'bound'), { statusCode: 422 })
          },
        },
      }))

    const res = await (await serve(jobs, formatted)).fetch('/jobs?timeout=forever')

    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toBe('bound')
  })

  it("prefers the route's own schemaErrorFormatter to the server's", async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .extend(fst({ schemaErrorFormatter: () => new Error('the route') }))
      .schema({ querystring: $t.Object({ timeout: $t.Duration() }) })
      .handler(ctx => ({ query: ctx.req.query() }))
    const formatted = (it: WebApplication<any, any, any, any>) =>
      it.server(() => ({ factory: { schemaErrorFormatter: () => new Error('the server') } }))

    const res = await (await serve(jobs, formatted)).fetch('/jobs?timeout=forever')

    expect(((await res.json()) as { message: string }).message).toBe('the route')
  })

  // A schema TypeBox cannot compile fails start-up naming where it is, not with TypeBox's bare "Unknown type".
  it('refuses at start-up a slot TypeBox cannot check, naming the route and the slot', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ querystring: $t.Object({ timeout: $t.Duration(), raw: $t.Unsafe<string>({ type: 'string' }) }) })
      .handler(ctx => ({ query: ctx.req.query() }))

    app = createWebApplication().mount(jobs)

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_CONFIGURATION',
      message: expect.stringContaining('Cannot compile the "GET /jobs querystring" schema'),
    })
  })

  it("writes the error message with the server's schemaErrorFormatter", async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ querystring: $t.Object({ timeout: $t.Duration() }) })
      .handler(ctx => ({ query: ctx.req.query() }))
    const formatted = (it: WebApplication<any, any, any, any>) =>
      it.server(() => ({
        factory: {
          schemaErrorFormatter: (errors: unknown[], slot: string) => new Error(`${slot}: ${errors.length} failure`),
        },
      }))

    const res = await (await serve(jobs, formatted)).fetch('/jobs?timeout=forever')

    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toBe('querystring: 1 failure')
  })
})

describe('a route whose response schema holds a codec', () => {
  // The client reads the text the schema declares, and fast-json-stringify still writes only the declared fields.
  it('sends the encoded text, and still leaves out undeclared fields', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ response: { 200: $t.Object({ ttl: $t.Duration() }) } })
      .handler(() => ({ ttl: 5000, secret: 'x' }))

    const res = await (await serve(jobs)).fetch('/jobs')

    expect(await res.json()).toEqual({ ttl: '5s' })
  })

  // Fastify reads a status class in either case and falls back to `default`; the encoding must follow the same schema.
  it('encodes under a status class written in capitals, and under default', async () => {
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ response: { '2XX': $t.Object({ ttl: $t.Duration() }), default: $t.Object({ wait: $t.Duration() }) } })
      .handler(ctx => (ctx.req.query('late') === undefined ? { ttl: 5000 } : ctx.status(503).body({ wait: 30000 })))

    const server = await serve(jobs)

    expect(await (await server.fetch('/jobs')).json()).toEqual({ ttl: '5s' })
    expect(await (await server.fetch('/jobs?late')).json()).toEqual({ wait: '30s' })
  })

  it('answers 500 when a codec cannot encode what the handler returned', async () => {
    const failing = $t
      .Transform($t.String())
      .Decode(value => value)
      .Encode((): string => {
        throw new Error('cannot encode')
      })
    const jobs = newRouter('/jobs')
      .get('/')
      .schema({ response: { 200: $t.Object({ ttl: failing }) } })
      .handler(() => ({ ttl: 'x' }))

    const res = await (await serve(jobs)).fetch('/jobs')

    expect(res.status).toBe(500)
  })
})

describe('a route whose schema is a Standard Schema', () => {
  it("refuses what the library's refinements refuse", async () => {
    const accounts = newRouter('/accounts')
      .post('/')
      .schema({ body: z.object({ email: z.string().refine(v => v.includes('@'), 'must be an email') }) })
      .handler(ctx => ({ body: ctx.req.body() }))

    const res = await (await serve(accounts)).fetch('/accounts', json({ email: 'nope' }))

    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toBe('body/email must be an email')
  })

  it("hands the handler what the library's transforms produced", async () => {
    const accounts = newRouter('/accounts')
      .post('/')
      .schema({ body: z.object({ name: z.string().transform(v => v.trim()) }) })
      .handler(ctx => ({ body: ctx.req.body() }))

    const res = await (await serve(accounts)).fetch('/accounts', json({ name: '  cat ' }))

    expect(await res.json()).toEqual({ body: { name: 'cat' } })
  })
})

describe('a route whose schema is an asynchronous Standard Schema', () => {
  it('waits for the library, then validates the slots after it', async () => {
    const accounts = newRouter('/accounts')
      .post('/')
      .schema({
        body: z.object({ name: z.string().refine(async name => name !== 'taken', 'is taken') }),
        querystring: $t.Object({ ttl: $t.Duration() }),
      })
      .handler(ctx => ({ body: ctx.req.body(), query: ctx.req.query() }))

    const server = await serve(accounts)

    expect(await (await server.fetch('/accounts?ttl=1m', json({ name: 'cat' }))).json()).toEqual({
      body: { name: 'cat' },
      query: { ttl: 60000 },
    })
    expect(
      ((await (await server.fetch('/accounts?ttl=1m', json({ name: 'taken' }))).json()) as { message: string }).message,
    ).toBe('body/name is taken')
  })

  // Fastify reads a falsy `done(error)` as "go on": a library that rejects without a reason must not let the request
  // through unvalidated.
  it('fails the request when the library rejects, whatever it rejects with', async () => {
    let handled = false
    const rejecting = {
      '~standard': { version: 1 as const, vendor: 'test', validate: () => Promise.reject(undefined) },
    }
    const accounts = newRouter('/accounts')
      .post('/')
      .schema({ body: rejecting })
      .handler(() => {
        handled = true
        return { ok: true }
      })

    const res = await (await serve(accounts)).fetch('/accounts', json({ name: 'cat' }))

    expect(res.status).toBe(500)
    expect(handled).toBe(false)
  })
})

describe('a route whose schema holds neither', () => {
  it("is still validated by Fastify's Ajv", async () => {
    const pets = newRouter('/pets')
      .get('/')
      .schema({ querystring: $t.Object({ page: $t.Integer() }) })
      .handler(ctx => ({ query: ctx.req.query() }))

    const res = await (await serve(pets)).fetch('/pets?page=x')

    expect(((await res.json()) as { message: string }).message).toBe('querystring/page must be integer')
  })
})
