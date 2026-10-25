import { createHash, createHmac } from 'node:crypto'

import { $t } from '@caffeinejs/application/schema'
import { Router, bodyAsBuffer, bodyAsStream } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { multipart, multipartPlugin } from '@caffeinejs/multipart'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { brewer, type BrewOptions, type Interceptor } from '../index.js'
import { bodies, profileForm } from './_bodies.js'
import { etagCache, idempotency, logging, mapErrors, retry, signing, timeout } from './_interceptors.js'

/**
 * Interceptors as applications write them, against a real server: tracing, an idempotent retry, a per-attempt
 * timeout, a logger that redacts, an ETag cache, request signing, error mapping and failover.
 *
 * Every route records what reached it, a body by its SHA-256, so each test asserts on what the server read rather than
 * on what an interceptor meant to send.
 */

interface Seen {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string | null>
  type: string | null
  size: number
  sha256: string | null
}

const RECORDED = ['x-request-id', 'idempotency-key', 'if-none-match', 'x-signature', 'x-tenant', 'x-rewritten']

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// What reached the server, request by request, in the order they arrived.
const seen: Seen[] = []

function record(
  ctx: {
    req: { method: string; url: string; query(): Record<string, string>; header(key: string): string | undefined }
  },
  bytes?: Uint8Array,
): Seen {
  const entry: Seen = {
    method: ctx.req.method,
    path: ctx.req.url.split('?')[0]!,
    query: ctx.req.query(),
    headers: Object.fromEntries(RECORDED.map(name => [name, ctx.req.header(name) ?? null])),
    type: ctx.req.header('content-type') ?? null,
    size: bytes?.byteLength ?? 0,
    sha256: bytes === undefined ? null : sha256(bytes),
  }
  seen.push(entry)

  return entry
}

// The statuses the flaky route answers with, in turn, before it answers 200.
let script: number[] = []

// Holds a request in its handler until the test lets it go, so an abort lands while the server is still working.
let latch: { started: () => void; held: Promise<void> } | undefined

function hold(): { started: Promise<void>; release: () => void } {
  const started = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  latch = { started: started.resolve, held: held.promise }

  return { started: started.promise, release: held.resolve }
}

// The body the event stream answers with, written by the test in progress.
let feeding: ReadableStream<Uint8Array> | undefined

function feed(): { write(text: string): void; end(): void } {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  feeding = new ReadableStream<Uint8Array>({
    start: c => {
      controller = c
    },
  })

  return { write: text => controller.enqueue(encoder.encode(text)), end: () => controller.close() }
}

// Resolved by the streaming route as the first chunk of an upload reaches it.
let firstChunk: (() => void) | undefined

const SIGNING_KEY = 'the shared signing key'

const api = new Router('/api')
  .get('/echo')
  .handler(ctx => record(ctx))
  .post('/echo')
  .extend(bodyAsBuffer())
  .handler(ctx => record(ctx, ctx.req.body() as Uint8Array))
  .put('/echo')
  .extend(bodyAsBuffer())
  .handler(ctx => record(ctx, ctx.req.body() as Uint8Array))
  .query('/echo')
  .extend(bodyAsBuffer())
  .handler(ctx => record(ctx, ctx.req.body() as Uint8Array))
  // HEAD on a path no GET answers: a GET's own HEAD twin would collide with it.
  .head('/peek')
  .handler(ctx => {
    record(ctx)
    ctx.header('x-found', 'yes')
  })
  .delete('/echo')
  .status(204)
  .handler(ctx => {
    record(ctx)
    return undefined
  })
  .post('/flaky')
  .extend(bodyAsBuffer())
  .handler(ctx => {
    record(ctx, ctx.req.body() as Uint8Array)
    const status = script.shift() ?? 200
    return Response.json({ attempt: seen.length }, { status })
  })
  .get('/held')
  .handler(async ctx => {
    record(ctx)
    latch?.started()
    await latch?.held
    return { done: true }
  })
  .get('/cached')
  .handler(ctx => {
    record(ctx)
    if (ctx.req.header('if-none-match') === '"v1"') {
      return new Response(null, { status: 304, headers: { etag: '"v1"' } })
    }
    return Response.json({ pets: ['Rex', 'Tom'] }, { headers: { etag: '"v1"' } })
  })
  .post('/signed')
  .extend(bodyAsBuffer())
  .handler(ctx => {
    const bytes = ctx.req.body() as Uint8Array
    record(ctx, bytes)
    const expected = createHmac('sha256', SIGNING_KEY)
      .update(`${ctx.req.method}\n${ctx.req.url}\n${sha256(bytes)}`)
      .digest('hex')
    return { valid: ctx.req.header('x-signature') === expected }
  })
  .get('/status/:code')
  .schema({ params: $t.Object({ code: $t.Integer() }) })
  .handler(ctx => Response.json({ code: ctx.req.param().code }, { status: ctx.req.param().code }))
  .get('/events')
  .handler(() => new Response(feeding, { headers: { 'content-type': 'text/event-stream' } }))
  .post('/stream')
  .extend(bodyAsStream())
  .handler(async ctx => {
    let size = 0
    for await (const chunk of ctx.req.body() as ReadableStream<Uint8Array>) {
      size += chunk.byteLength
      firstChunk?.()
    }
    return { size }
  })

type Part = { field: string; value: string } | { field: string; name: string; type: string; sha256: string }

// What each form that reached the server carried, part by part, in the order they arrived.
const forms: Part[][] = []

const uploads = new Router('/uploads').post('/form').handler(async ctx => {
  const parts: Part[] = []
  for (const [field, value] of await multipart(ctx).formData()) {
    parts.push(
      typeof value === 'string'
        ? { field, value }
        : { field, name: value.name, type: value.type, sha256: sha256(await value.bytes()) },
    )
  }
  forms.push(parts)
  ctx.status(script.shift() ?? 200)
  return { parts }
})

// An abort can leave the client a connection it opened and never finished a request on, which the server's graceful
// close would otherwise wait out: a connection quiet for a second is dropped instead.
const app = createWebApplication()
  .server(() => ({ factory: { connectionTimeout: 1000 } }))
  .with(() => multipartPlugin({ limits: { fileSize: 64 * 1024 } }))
  .mount(api, uploads)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  seen.length = 0
  forms.length = 0
  script = []
})

const passThrough: Interceptor = (request, next) => next(request)

const transports = [
  ['in process', (options?: BrewOptions) => brewer(app, options)],
  ['over a socket', (options?: BrewOptions) => brewer<typeof app>(origin, options)],
] as const

describe.each(transports)('brewer through interceptors, %s', (_transport, connect) => {
  describe('given several interceptors', () => {
    // The first listed wraps the rest: a logger there sees what every later one did to the request and the response.
    it('should run them in the order listed, the first seeing the request first and the response last', async () => {
      const order: string[] = []
      const mark =
        (name: string): Interceptor =>
        async (request, next) => {
          order.push(`${name} >`)
          const response = await next(request)
          order.push(`< ${name}`)
          return response
        }
      const client = connect({ interceptors: [mark('first'), mark('second')] })

      await client.api.echo.get()

      expect(order).toEqual(['first >', 'second >', '< second', '< first'])
    })
  })

  describe('given a tracing interceptor that stamps every request', () => {
    // Following a call across services starts with each request carrying its own ID, under any load.
    it("should carry each call's own ID to the server, 50 at once, and leave the client's headers as they were", async () => {
      const clientHeaders = new Headers({ 'x-tenant': 'acme' })
      const client = connect({
        headers: clientHeaders,
        interceptors: [
          async (request, next) => {
            request.headers.set('x-request-id', `req-${new URL(request.url).searchParams.get('n')}`)
            return next(request)
          },
        ],
      })

      const results = await Promise.all(
        Array.from({ length: 50 }, async (_, n) => (await client.api.echo.get({ query: { n } })).json()),
      )

      expect(results.map(result => result.headers['x-request-id'])).toEqual(
        results.map(result => `req-${result.query['n']}`),
      )
      expect(results.every(result => result.headers['x-tenant'] === 'acme')).toBe(true)
      expect(clientHeaders.has('x-request-id')).toBe(false)
    })
  })

  describe('given a payment retried on 503 under an idempotency key', () => {
    // A retried write must reach the server as the same write: another key would charge twice, an empty body would
    // charge nothing.
    it.each(bodies)('should send %s again whole, under the same key', async (_kind, body) => {
      script = [503, 503]
      let keys = 0
      const client = connect({ interceptors: [idempotency(() => `key-${++keys}`), retry({ attempts: 3 })] })

      const res = await client.api.flaky.post({ body: body() })

      expect(res.status).toBe(200)
      expect(seen).toHaveLength(3)
      expect(seen.map(entry => entry.headers['idempotency-key'])).toEqual(['key-1', 'key-1', 'key-1'])
      expect(new Set(seen.map(entry => entry.sha256)).size).toBe(1)
      expect(new Set(seen.map(entry => entry.type)).size).toBe(1)
      expect(seen[0]!.size).toBeGreaterThan(0)
    })

    it('should send a form with files again part for part', async () => {
      script = [503]
      const client = connect({ interceptors: [retry({ attempts: 2 })] })

      const res = await client.uploads.form.post({ body: profileForm() })

      expect(res.status).toBe(200)
      expect(forms).toHaveLength(2)
      expect(forms[1]).toEqual(forms[0])
      expect(forms[0]).toHaveLength(3)
    })

    // The caller decides what a lasting outage means, so it gets the last answer, readable.
    it('should resolve with the last 503 once the attempts run out, its body readable', async () => {
      script = [503, 503, 503]
      const client = connect({ interceptors: [retry({ attempts: 3 })] })

      const res = await client.api.flaky.post({ body: 'charge 10' })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ attempt: 3 })
    })

    // A refusal is the server's answer to this request; sending it again would only be refused again.
    it('should not retry a refusal', async () => {
      script = [409]
      const client = connect({ interceptors: [retry({ attempts: 3 })] })

      const res = await client.api.flaky.post({ body: 'charge 10' })

      expect(res.status).toBe(409)
      expect(seen).toHaveLength(1)
    })

    // A user who leaves the page must not keep paying for a backoff, nor have the payment sent behind their back.
    it('should reject at once with the reason while a backoff waits, and the abandoned retry send nothing', async () => {
      script = [503]
      const waiting = Promise.withResolvers<void>()
      const backoff = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      const controller = new AbortController()
      const client = connect({
        interceptors: [
          retry({
            attempts: 2,
            wait: () => {
              waiting.resolve()
              return backoff.promise
            },
            settled: settled.resolve,
          }),
        ],
      })

      const call = client.api.flaky.post({ body: 'charge 10', signal: controller.signal })
      await waiting.promise
      controller.abort(new Error('the user left the page'))

      await expect(call).rejects.toThrow('the user left the page')
      backoff.resolve()
      await settled.promise
      expect(seen).toHaveLength(1)
    })
  })

  describe('given a logging interceptor that redacts credentials', () => {
    // A log leaves the process: a token or a query secret written there has leaked.
    it('should log the exchange without the token or the query secret, and leave the body to the caller', async () => {
      const lines: string[] = []
      const client = connect({ headers: { authorization: 'Bearer s3cret-token' }, interceptors: [logging(lines)] })

      const res = await client.api.echo.get({ query: { api_key: 's3cret-key' } })

      expect(await res.json()).toMatchObject({ method: 'GET', query: { api_key: 's3cret-key' } })
      expect(lines).toEqual([
        expect.stringMatching(/^--> GET \/api\/echo .*authorization: \[redacted\]/),
        expect.stringMatching(/^<-- 200 \/api\/echo \d+ bytes$/),
      ])
      expect(lines.join('\n')).not.toContain('s3cret')
    })
  })

  describe('given a cache that revalidates with ETags', () => {
    // A 304 carries no body: serving the one kept is the interceptor's job, and the caller must not see the difference.
    it('should revalidate the second read and serve the kept body when the server answers 304', async () => {
      const client = connect({ interceptors: [etagCache()] })

      const first = await client.api.cached.get()
      const second = await client.api.cached.get()

      expect(second.status).toBe(200)
      expect(await second.json()).toEqual(await first.json())
      expect(seen.map(entry => entry.headers['if-none-match'])).toEqual([null, '"v1"'])
    })
  })

  describe('given an interceptor that signs every request', () => {
    // A signature covers the bytes as sent: reading the body to sign it must leave exactly those bytes to send.
    it.each(bodies)('should send %s under a signature the server verifies', async (_kind, body) => {
      const client = connect({ interceptors: [signing(SIGNING_KEY)] })

      const res = await client.api.signed.post({ body: body(), query: { region: 'eu' } })

      expect(await res.json()).toEqual({ valid: true })
    })
  })

  describe('given an interceptor that maps server failures to errors of its own', () => {
    // One place holds the team's error policy, while a refusal the caller handles stays a typed response.
    it('should reject with the mapped error on a 5xx, and resolve a 4xx as it is', async () => {
      const client = connect({ interceptors: [mapErrors()] })

      await expect(client.api.status({ code: 502 }).get()).rejects.toMatchObject({ name: 'ErrUpstream', status: 502 })
      const res = await client.api.status({ code: 404 }).get()

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ code: 404 })
    })
  })

  describe('given an interceptor that answers without the server', () => {
    // A cache hit or an offline stub must not touch the network.
    it('should resolve with its response and send nothing', async () => {
      const client = connect({ interceptors: [async () => Response.json({ offline: true })] })

      const res = await client.api.echo.post({ body: { amount: 10 } })

      expect(await res.json()).toEqual({ offline: true })
      expect(seen).toEqual([])
    })

    // The upload's source, a file or a socket, is opened only for a request that leaves.
    it('should never open a body a function would have opened', async () => {
      let opens = 0
      const client = connect({ interceptors: [async () => Response.json({ offline: true })] })

      await client.api.echo.post({
        body: () => {
          opens++
          return new Blob(['upload']).stream()
        },
      })

      expect(opens).toBe(0)
    })

    // A caller that left before the call was sent gets the reason it left with, not an answer: the cached response
    // nobody will read is cancelled.
    it('should reject with the reason a call aborted with before it was sent, and cancel the answer', async () => {
      const cancelled = Promise.withResolvers<unknown>()
      const cached: Interceptor = async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel: reason => cancelled.resolve(reason) }))
      const client = connect({ interceptors: [cached] })
      const controller = new AbortController()
      controller.abort(new Error('the user left the page'))

      await expect(client.api.echo.post({ body: { amount: 10 }, signal: controller.signal })).rejects.toThrow(
        'the user left the page',
      )
      await cancelled.promise
    })
  })

  describe('given an interceptor that hands on a request of its own', () => {
    // What an interceptor builds is what goes out: nothing downstream undoes a rewrite.
    it('should send that request: its method, its headers and the body it carried', async () => {
      const client = connect({
        interceptors: [
          async (request, next) => {
            const headers = new Headers(request.headers)
            headers.set('x-rewritten', 'yes')
            return next(new Request(request, { method: 'PUT', headers }))
          },
        ],
      })

      await client.api.echo.post({ body: { amount: 10 }, headers: { 'x-tenant': 'acme' } })

      expect(seen).toEqual([
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ 'x-rewritten': 'yes', 'x-tenant': 'acme' }),
          type: 'application/json',
          sha256: sha256(new TextEncoder().encode('{"amount":10}')),
        }),
      ])
    })
  })

  describe('given an interceptor that fails', () => {
    // Its error explains the failure better than anything after it could, and a request it refused must not leave.
    it.each([
      [
        'throws',
        (() => {
          throw new Error('no route to the vault')
        }) as Interceptor,
      ],
      ['rejects', (async () => Promise.reject(new Error('no route to the vault'))) as Interceptor],
    ])('should reject the call with its error when it %s, and send nothing', async (_how, failing) => {
      const client = connect({ interceptors: [failing] })

      await expect(client.api.echo.get()).rejects.toThrow('no route to the vault')
      expect(seen).toEqual([])
    })

    // A fallback written with `.catch()` attaches its handler to what `next` returns: a synchronous throw further in
    // must arrive there as a rejection, not escape before the handler exists.
    it('should hand a synchronous throw to the interceptor before it, as a rejection it can catch', async () => {
      const fallback: Interceptor = (request, next) =>
        next(request).catch((error: unknown) => Response.json({ fallback: (error as Error).message }))
      const broken: Interceptor = () => {
        throw new Error('sync failure')
      }
      const client = connect({ interceptors: [fallback, broken] })

      const res = await client.api.echo.get()

      expect(await res.json()).toEqual({ fallback: 'sync failure' })
    })
  })

  describe('given an interceptor that sends one request twice', () => {
    // A body is read as it is sent: sending it again must fail loudly, never go out empty.
    it('should reject the second send with a TypeError, the server having read one whole body', async () => {
      const client = connect({
        interceptors: [
          async (request, next) => {
            const first = await next(request)
            await first.body?.cancel()
            return next(request)
          },
        ],
      })

      await expect(client.api.echo.post({ body: { amount: 10 } })).rejects.toThrow(TypeError)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.size).toBe('{"amount":10}'.length)
    })
  })

  describe('given a body of each kind', () => {
    // Building a `Request` must change nothing the server reads: its type, its bytes, a view's slice of them.
    it.each(bodies)('should deliver %s exactly as a client without interceptors does', async (_kind, body) => {
      await connect().api.echo.post({ body: body() })
      await connect({ interceptors: [passThrough] }).api.echo.post({ body: body() })

      expect(seen).toHaveLength(2)
      expect(seen[1]).toEqual(seen[0])
    })

    it('should deliver a form with files part for part', async () => {
      const plain = await (await connect().uploads.form.post({ body: profileForm() })).json()
      const intercepted = await (
        await connect({ interceptors: [passThrough] }).uploads.form.post({ body: profileForm() })
      ).json()

      expect(intercepted).toEqual(plain)
      expect(plain.parts).toHaveLength(3)
    })
  })

  describe('given methods beyond GET and POST', () => {
    // QUERY carries a body on a safe method; HEAD and a 204 carry none back. A chain must keep all three intact.
    it('should send a QUERY with its body', async () => {
      const client = connect({ interceptors: [passThrough] })

      await client.api.echo.query({ body: { name: 'Rex' } })

      expect(seen).toEqual([expect.objectContaining({ method: 'QUERY', type: 'application/json', size: 14 })])
    })

    it('should resolve a HEAD with its headers and no body', async () => {
      const client = connect({ interceptors: [passThrough] })

      const res = await client.api.peek.head()

      expect(res.headers.get('x-found')).toBe('yes')
      expect(await res.text()).toBe('')
    })

    it('should resolve a DELETE answered 204 with no body', async () => {
      const client = connect({ interceptors: [passThrough] })

      const res = await client.api.echo.delete()

      expect(res.status).toBe(204)
      expect(res.body).toBeNull()
    })
  })

  describe('given a call that aborts while the server holds it', () => {
    // An aborted call must let its caller go at once, whatever the transport does with the signal.
    it('should reject at once with the abort', async () => {
      const client = connect({ interceptors: [passThrough] })
      const controller = new AbortController()
      const { started, release } = hold()

      try {
        const call = client.api.held.get({ signal: controller.signal })
        await started
        controller.abort()

        await expect(call).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        release()
      }
    })
  })
})

describe('brewer through interceptors over a socket', () => {
  // A deadline per attempt aborts that attempt alone: its signal follows the call's and adds its own.
  it("should abort an attempt past its deadline, through a signal derived from the call's", async () => {
    const deadline = Promise.withResolvers<void>()
    const client = brewer<typeof app>(origin, { interceptors: [timeout(() => deadline.promise)] })
    const { started, release } = hold()

    try {
      const call = client.api.held.get()
      await started
      deadline.resolve()

      await expect(call).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      release()
    }
  })

  // A primary that refuses connections is the case failover exists for; the write must reach the secondary whole.
  it('should fail over to a second origin when the first refuses the connection, the body whole', async () => {
    const gone = createWebApplication().mount(api)
    await gone.run()
    const primary = gone.address!.origin
    await gone.close()
    const failover: Interceptor = async (request, next) => {
      const spare = request.clone()
      try {
        return await next(request)
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error
        }
        return next(new Request(spare.url.replace(primary, origin), spare))
      }
    }
    const client = brewer<typeof app>(primary, { interceptors: [failover] })

    const res = await client.api.echo.post({ body: { amount: 10 } })

    expect(res.status).toBe(200)
    expect(seen).toEqual([
      expect.objectContaining({ method: 'POST', sha256: sha256(new TextEncoder().encode('{"amount":10}')) }),
    ])
  })

  // Server-sent events are read as they arrive: a chain that waited for the end would never deliver the first.
  it('should pass a stream of events through as it arrives', async () => {
    const lines: string[] = []
    const client = brewer<typeof app>(origin, { interceptors: [logging(lines)] })
    const events = feed()
    events.write('data: 1\n\n')

    const res = await client.api.events.get()
    const reader = res.body!.getReader()
    const first = await reader.read()
    events.write('data: 2\n\n')
    events.end()
    const second = await reader.read()

    expect(new TextDecoder().decode(first.value)).toBe('data: 1\n\n')
    expect(new TextDecoder().decode(second.value)).toBe('data: 2\n\n')
    expect(lines.at(-1)).toBe('<-- 200 /api/events not read')
  })

  // The second chunk exists only once the server has read the first: a chain that read the whole body before sending
  // it would wait forever.
  it('should stream an upload through the chain as it is read', async () => {
    const client = brewer<typeof app>(origin, { interceptors: [passThrough] })
    const reached = Promise.withResolvers<void>()
    firstChunk = reached.resolve
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls++
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(1024).fill(1))
        } else if (pulls === 2) {
          await reached.promise
          controller.enqueue(new Uint8Array(1024).fill(2))
        } else {
          controller.close()
        }
      },
    })

    try {
      const res = await client.api.stream.post({ body })

      expect(await res.json()).toEqual({ size: 2048 })
    } finally {
      firstChunk = undefined
    }
  })
})

describe('brewer through interceptors in process, with the application not ready', () => {
  // A failure of the transport reaches `next`, so an interceptor can answer in its place.
  it('should reject next with the failure, which an interceptor can answer', async () => {
    const unready = createWebApplication().mount(api)
    const client = brewer(unready, {
      interceptors: [
        async (request, next) => {
          try {
            return await next(request)
          } catch (error) {
            return Response.json({ fallback: (error as Error).name }, { status: 503 })
          }
        },
      ],
    })

    const res = await client.api.echo.get()

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ fallback: 'ErrApplicationNotReady' })
  })
})

describe('brewer handing a chain to its transport', () => {
  // The transport reads every RequestInit field off the one `Request` it is handed, the call's winning the client's.
  it("should hand it one Request carrying the client's and the call's RequestInit fields", async () => {
    const calls: Array<{ input: unknown; init: unknown }> = []
    const client = brewer(app, {
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: true,
      redirect: 'manual',
      interceptors: [passThrough],
      fetch: (input, init) => {
        calls.push({ input, init })
        return app.request(input, init)
      },
    })

    await client.api.echo.get({ cache: 'reload' })

    expect(calls).toHaveLength(1)
    const { input, init } = calls[0]!
    expect(init).toBeUndefined()
    expect(input).toBeInstanceOf(Request)
    const request = input as Request
    expect({
      method: request.method,
      credentials: request.credentials,
      cache: request.cache,
      referrerPolicy: request.referrerPolicy,
      keepalive: request.keepalive,
      redirect: request.redirect,
    }).toEqual({
      method: 'GET',
      credentials: 'include',
      cache: 'reload',
      referrerPolicy: 'no-referrer',
      keepalive: true,
      redirect: 'manual',
    })
  })

  // A client with nothing to run around its requests sends them exactly as it always has.
  it('should keep handing it the URL and the init when there are no interceptors, an empty list included', async () => {
    const calls: Array<{ input: unknown; init: unknown }> = []
    const client = brewer(app, {
      interceptors: [],
      fetch: (input, init) => {
        calls.push({ input, init })
        return app.request(input, init)
      },
    })

    await client.api.echo.get()

    expect(calls).toEqual([{ input: 'http://localhost/api/echo', init: expect.objectContaining({ method: 'GET' }) }])
  })

  // Outside a browser there is no page to resolve a path against, and a request must not leave for a guessed origin.
  it('should reject a base URL that is only a path before anything is sent', async () => {
    const calls: unknown[] = []
    const client = brewer<typeof app>('/gateway', {
      interceptors: [passThrough],
      fetch: async input => {
        calls.push(input)
        return new Response(null, { status: 204 })
      },
    })

    await expect(client.api.echo.get()).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })
})
