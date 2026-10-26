import { once } from 'node:events'
import { gzipSync } from 'node:zlib'

import { Byte, KiB, MiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { Router, bodyAsStream, type IContext, type WebApplication } from '../../index.js'
import { createWebApplication } from './index.js'

/**
 * A server's `request` is a pass-through: the request reaches the server as its `(input, init)` describes it, and the
 * answer comes back as the server wrote it, so a client in the same process, or a runtime handing over the requests
 * it received, sees what a socket would carry.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function serve(router: Router): Promise<WebApplication> {
  app = createWebApplication().mount(router) as WebApplication
  await app.bootstrap()
  return app
}

describe('a server request', () => {
  // `fetch` builds `new Request(input, init)` whatever the input: a client holding a `Request` overrides it the same
  // way.
  it('sends a Request under the init it is given, as fetch does', async () => {
    const router = new Router('/echo')
    router.get('/').handler(() => ({ method: 'GET' }))
    router
      .post('/')
      .handler(ctx => ({ method: 'POST', probe: ctx.req.header('x-probe') ?? null, body: ctx.req.body() }))
    const server = await serve(router)

    const res = await server.request(new Request('http://localhost/echo', { headers: { 'x-probe': 'request' } }), {
      method: 'POST',
      headers: { 'x-probe': 'init', 'content-type': 'text/plain' },
      body: 'from init',
    })

    expect(await res.json()).toEqual({ method: 'POST', probe: 'init', body: 'from init' })
  })

  // The caller's `Request` is the caller's: what is sent is a copy, as `fetch` sends one.
  it("leaves the headers of the caller's Request as they were", async () => {
    const router = new Router('/echo')
    router.post('/').handler(ctx => ({ body: ctx.req.body() }))
    const server = await serve(router)

    const request = new Request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
      body: 'hello',
    })

    expect(await (await server.request(request)).json()).toEqual({ body: 'hello' })
    expect(request.headers.get('content-length')).toBe('5')
  })

  // A client writes the host of the URL it sends to, with no port when the scheme's default is meant.
  it('names the host the URL names, as a client writes it, unless the request carries its own', async () => {
    const router = new Router('/host')
    router.get('/').handler(ctx => ({ host: ctx.req.host }))
    const server = await serve(router)
    const hostOf = async (input: string, init?: RequestInit) =>
      ((await (await server.request(input, init)).json()) as { host: string }).host

    expect(await hostOf('/host')).toBe('localhost')
    expect(await hostOf('http://api.example/host')).toBe('api.example')
    expect(await hostOf('https://api.example/host')).toBe('api.example')
    expect(await hostOf('http://api.example:8080/host')).toBe('api.example:8080')
    expect(await hostOf('/host', { headers: { host: 'tenant.example' } })).toBe('tenant.example')
  })

  // A redirect is the server's answer: following it, or refusing it, is a client's business, and an in-process call
  // reaches one server only.
  it.each([undefined, 'follow', 'manual', 'error'] as const)(
    'answers a redirect as the server wrote it, with redirect: %s',
    async redirect => {
      const router = new Router('/moved')
      router.get('/').handler(ctx => {
        ctx.redirect('/elsewhere')
      })
      const server = await serve(router)

      const res = await server.request('/moved', redirect === undefined ? {} : { redirect })

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/elsewhere')
    },
  )
})

// The requests a client can hang up on: one with no body, and two whose body the server has read by then, one sent
// whole and one streamed under its length.
const sends: ReadonlyArray<readonly [string, RequestInit]> = [
  ['with no body', { method: 'GET' }],
  ['with a body sent whole', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }],
  [
    'with a body streamed under its length',
    { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '7' }, body: '{"a":1}' },
  ],
]

// Serves `handler` at `path` for each method `sends` uses.
function serveBoth(path: string, handler: (ctx: IContext) => unknown): Promise<WebApplication> {
  const router = new Router(path)
  router.get('/').handler(handler)
  router.post('/').handler(handler)
  return serve(router)
}

describe.each(sends)('a server request hung up on, %s', (_, sent) => {
  // An aborted call is refused before anything is sent, as `fetch` refuses it.
  it('rejects with the reason of a signal aborted before the call, and never sends the request', async () => {
    let handled = 0
    const server = await serveBoth('/aborted', () => {
      handled++
      return { ok: true }
    })
    const reason = new Error('the caller left')

    await expect(server.request('/aborted', { ...sent, signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    await expect(
      server.request(new Request('http://localhost/aborted', { ...sent, signal: AbortSignal.abort(reason) })),
    ).rejects.toBe(reason)
    // The request sent after them is the first the handler sees.
    expect(await (await server.request('/aborted', sent)).json()).toEqual({ ok: true })
    expect(handled).toBe(1)
  })

  // The caller leaving is a client hanging up: the handler sees its request close, and can stop the work it was doing.
  it("rejects with an abort's reason while the handler runs, and closes the request it holds", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const held = Promise.withResolvers<void>()
    const server = await serveBoth('/slow', async ctx => {
      started.resolve(ctx.signal)
      await held.promise
      return { ok: true }
    })
    const controller = new AbortController()
    const reason = new Error('the caller left')

    try {
      const call = server.request('/slow', { ...sent, signal: controller.signal })
      const signal = await started.promise
      const closed = once(signal, 'abort')
      controller.abort(reason)

      await expect(call).rejects.toBe(reason)
      await closed
      expect(signal.aborted).toBe(true)
    } finally {
      held.resolve()
    }
  })

  // A body read after the caller left fails as `fetch`'s does, and the stream behind it is released, not left to run.
  it("fails the body being read with an abort's reason, and cancels the stream answered with", async () => {
    const cancelled = Promise.withResolvers<void>()
    const server = await serveBoth(
      '/feed',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: controller => controller.enqueue(encoder.encode('part one')),
            cancel: () => cancelled.resolve(),
          }),
        ),
    )
    const controller = new AbortController()
    const reason = new Error('the caller left')

    const res = await server.request('/feed', { ...sent, signal: controller.signal })
    const reader = res.body!.getReader()
    expect(decoder.decode((await reader.read()).value)).toBe('part one')

    controller.abort(reason)

    await expect(reader.read()).rejects.toBe(reason)
    await cancelled.promise
  })

  // A client that stops reading hangs up: the server stops writing, and the stream it answered with is released.
  it('releases the stream the handler answered with when the body is cancelled', async () => {
    const cancelled = Promise.withResolvers<void>()
    const server = await serveBoth(
      '/ticks',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: controller => controller.enqueue(encoder.encode('tick')),
            cancel: () => cancelled.resolve(),
          }),
        ),
    )

    const res = await server.request('/ticks', sent)
    await res.body!.cancel()

    await cancelled.promise
  })
})

describe('a server request streaming', () => {
  // An event stream never ends on its own: the answer has to be handed over as the server starts writing it, and each
  // event as it comes. Fastify writes the headers with the first chunk, over a socket too.
  it('answers as the server starts writing, and hands over the body as it is written', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>
    const events = new ReadableStream<Uint8Array>({ start: controller => void (feed = controller) })
    const router = new Router('/events')
    router.get('/').handler(() => new Response(events, { headers: { 'content-type': 'text/event-stream' } }))
    const server = await serve(router)

    feed.enqueue(encoder.encode('data: 1\n\n'))
    const res = await server.request('/events')
    const reader = res.body!.getReader()

    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(decoder.decode((await reader.read()).value)).toBe('data: 1\n\n')
    feed.enqueue(encoder.encode('data: 2\n\n'))
    expect(decoder.decode((await reader.read()).value)).toBe('data: 2\n\n')
    feed.close()
    expect((await reader.read()).done).toBe(true)
  })

  // `fetch` hands each chunk over as bytes of its own: a reader may keep it, or its buffer, and read nothing else.
  it('hands over each chunk as a Uint8Array of its own', async () => {
    const router = new Router('/bytes')
    router.get('/').handler(() => new Response('data'))
    const server = await serve(router)

    const { value } = await (await server.request('/bytes')).body!.getReader().read()

    expect(value!.constructor).toBe(Uint8Array)
    expect(value!.buffer.byteLength).toBe(4)
    expect(decoder.decode(value)).toBe('data')
  })

  // An upload the request sends as it is written reaches the route the same way, not once it has all arrived.
  it('hands a chunked request body to the route as it is written', async () => {
    const first = Promise.withResolvers<string>()
    const router = new Router('/upload')
    router
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => {
        const reader = (ctx.req.body() as ReadableStream<Uint8Array>).getReader()
        const head = decoder.decode((await reader.read()).value)
        first.resolve(head)
        let rest = ''
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          rest += decoder.decode(chunk.value)
        }
        return { head, rest }
      })
    const server = await serve(router)
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: controller => void (source = controller) })

    source.enqueue(encoder.encode('one,'))
    const call = server.request('/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      body,
      duplex: 'half',
    } as RequestInit)

    expect(await first.promise).toBe('one,')
    source.enqueue(encoder.encode('two'))
    source.close()
    expect(await (await call).json()).toEqual({ head: 'one,', rest: 'two' })
  })

  // A body with no length is read whole by the call itself: an abort stops the read and releases the caller's stream,
  // as `fetch` cancels a request body when it aborts.
  it('stops reading a body it reads whole when the call aborts, and releases it', async () => {
    const router = new Router('/whole')
    router.post('/').handler(() => ({ ok: true }))
    const server = await serve(router)
    const pulled = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    // Endless: a read that goes on after the abort never ends.
    const body = new ReadableStream<Uint8Array>({
      pull: controller => {
        pulled.resolve()
        controller.enqueue(new Uint8Array(256))
      },
      cancel: () => cancelled.resolve(),
    })
    const controller = new AbortController()
    const reason = new Error('the caller left')

    const call = server.request('/whole', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit)
    await pulled.promise
    controller.abort(reason)

    await expect(call).rejects.toBe(reason)
    await cancelled.promise
  })

  // A length over the limit is refused up front: the upload is never held, however long it is, and is let go after.
  it("refuses a request body whose content-length passes the route's limit without reading it", async () => {
    let handled = 0
    const router = new Router('/limited')
    router
      .post('/')
      .bodyLimit(1 * KiB)
      .handler(() => {
        handled++
        return { ok: true }
      })
    const server = await serve(router)
    const cancelled = Promise.withResolvers<void>()
    // Endless: a body read whole never ends.
    const body = new ReadableStream<Uint8Array>({
      pull: controller => controller.enqueue(new Uint8Array(256)),
      cancel: () => cancelled.resolve(),
    })

    const res = await server.request('/limited', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': String(64 * MiB) },
      body,
      duplex: 'half',
    } as RequestInit)

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })
    expect(handled).toBe(0)
    await cancelled.promise
  })
})

// A body is sent as its Content-Length says, or not at all: `fetch` refuses a body its header does not describe, and
// the server never reads past the length it was told.
describe('a server request framing a request body at its Content-Length', () => {
  // A route that reads the body it is handed, tells `onRead` what it holds after each chunk, and records what it held
  // when the read ended.
  async function serveReader(
    onRead: (received: string) => void = () => undefined,
  ): Promise<{ server: WebApplication; read: Promise<string>; handled: () => number }> {
    const read = Promise.withResolvers<string>()
    let handled = 0
    const router = new Router('/upload')
    router
      .post('/')
      .extend(bodyAsStream())
      .bodyLimit(64 * Byte)
      .handler(async ctx => {
        handled++
        let received = ''
        try {
          for await (const chunk of ctx.req.body() as ReadableStream<Uint8Array>) {
            received += decoder.decode(chunk)
            onRead(received)
          }
        } catch {
          // The request closed under the read: what arrived before it is the answer.
        }
        read.resolve(received)
        return { received }
      })

    return { server: await serve(router), read: read.promise, handled: () => handled }
  }

  const octets = { 'content-type': 'application/octet-stream' }

  it.each([
    [
      'a body under a Content-Length of 0',
      '0',
      'ten bytes!',
      'Cannot send the request body: it is longer than its Content-Length of 0 bytes',
    ],
    [
      'a body longer than its Content-Length',
      '10',
      'twenty-one bytes long',
      'Cannot send the request body: it is longer than its Content-Length of 10 bytes',
    ],
    [
      'a body shorter than its Content-Length',
      '10',
      'hello',
      'Cannot send the request body: it ended at 5 bytes, short of its Content-Length of 10 bytes',
    ],
  ])('rejects with a TypeError for %s', async (_, length, body, message) => {
    const { server } = await serveReader()

    const call = server.request('/upload', { method: 'POST', headers: { ...octets, 'content-length': length }, body })

    await expect(call).rejects.toThrow(TypeError)
    await expect(call).rejects.toThrow(message)
  })

  // An endless body under a short header is cut at the header: the route gets the declared bytes, and never reads on
  // up to its limit.
  it('stops an endless body one chunk past its Content-Length, and releases it', async () => {
    const eight = Promise.withResolvers<void>()
    const { server, read } = await serveReader(received => {
      if (received.length === 8) {
        eight.resolve()
      }
    })
    const cancelled = Promise.withResolvers<void>()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        // The chunk past the length waits for the route to hold the eight bytes before it.
        if (++pulls === 3) {
          await eight.promise
        }
        controller.enqueue(encoder.encode('abcd'))
      },
      cancel: () => cancelled.resolve(),
    })

    await expect(
      server.request('/upload', {
        method: 'POST',
        headers: { ...octets, 'content-length': '8' },
        body,
        duplex: 'half',
      } as RequestInit),
    ).rejects.toThrow('Cannot send the request body: it is longer than its Content-Length of 8 bytes')
    await cancelled.promise
    expect(await read).toBe('abcdabcd')
  })

  // A server may answer before it has read the whole body: the answer is its own, and the rest of the upload is let go.
  it('hands over an answer the server gave before reading the whole body, and releases the rest', async () => {
    const router = new Router('/first')
    router
      .post('/')
      .extend(bodyAsStream())
      .handler(async ctx => {
        const { value } = await (ctx.req.body() as ReadableStream<Uint8Array>).getReader().read()
        return { first: decoder.decode(value) }
      })
    const server = await serve(router)
    const cancelled = Promise.withResolvers<void>()
    // Open: the rest of the declared ten bytes never comes.
    const body = new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(encoder.encode('hello')),
      cancel: () => cancelled.resolve(),
    })

    const res = await server.request('/first', {
      method: 'POST',
      headers: { ...octets, 'content-length': '10' },
      body,
      duplex: 'half',
    } as RequestInit)

    expect(await res.json()).toEqual({ first: 'hello' })
    await cancelled.promise
  })

  it.each([
    [
      'a Content-Length that is not a count of bytes',
      { ...octets, 'content-length': 'abc' },
      'Cannot send the request: its Content-Length "abc" is not a count of bytes',
    ],
    [
      'a Content-Length beside Transfer-Encoding',
      { ...octets, 'content-length': '2', 'transfer-encoding': 'chunked' },
      'Cannot send the request: it carries both Transfer-Encoding and Content-Length',
    ],
  ])('rejects with a TypeError for %s, and sends nothing', async (_, headers, message) => {
    const { server, handled } = await serveReader()

    const call = server.request('/upload', { method: 'POST', headers, body: 'ok' })

    await expect(call).rejects.toThrow(TypeError)
    await expect(call).rejects.toThrow(message)
    // The request sent after it is the first the route sees.
    expect(await (await server.request('/upload', { method: 'POST', headers: octets, body: 'ok' })).json()).toEqual({
      received: 'ok',
    })
    expect(handled()).toBe(1)
  })

  // A body that cannot be read cannot be sent: the call rejects as `fetch` does, naming the failure as its cause.
  it.each([
    ['streamed under its Content-Length', { ...octets, 'content-length': '10' }],
    ['read whole', octets],
  ])('rejects with a TypeError caused by the failure of a body %s', async (_, headers) => {
    const { server } = await serveReader()
    const failure = new Error('the disk went away')
    const body = new ReadableStream<Uint8Array>({ pull: controller => controller.error(failure) })

    const call = server.request('/upload', { method: 'POST', headers, body, duplex: 'half' } as RequestInit)

    await expect(call).rejects.toThrow(TypeError)
    await expect(call).rejects.toThrow('Cannot send the request body: its stream failed')
    await expect(call).rejects.toMatchObject({ cause: failure })
  })
})

describe('a server request answering', () => {
  // No connection carries the answer, so nothing in it may describe one: forwarded, a chunked label on bytes that are
  // already the payload would be a message no client can read.
  it('leaves out the fields that describe a connection', async () => {
    const router = new Router('/chunks')
    router.get('/').handler(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: controller => {
              controller.enqueue(encoder.encode('AAA'))
              controller.enqueue(encoder.encode('BBB'))
              controller.close()
            },
          }),
        ),
    )
    const server = await serve(router)

    const res = await server.request('/chunks')

    expect(res.headers.get('transfer-encoding')).toBe(null)
    expect(res.headers.get('connection')).toBe(null)
    expect(await res.text()).toBe('AAABBB')
  })

  // A pass-through hands over the bytes the server wrote: decoding them is a client's business.
  it('hands over a compressed body as the server encoded it, under its Content-Encoding', async () => {
    const encoded = gzipSync('hello')
    const router = new Router('/gzip')
    router.get('/').handler(() => new Response(encoded, { headers: { 'content-encoding': 'gzip' } }))
    const server = await serve(router)

    const res = await server.request('/gzip')

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(encoded)
  })
})

describe('a server request sending an empty body', () => {
  async function serveLengths(): Promise<WebApplication> {
    const router = new Router('/length')
    const length = (ctx: IContext) => ({ length: ctx.req.header('content-length') ?? null })
    router.get('/').handler(length)
    router.post('/').handler(length)
    router.put('/').handler(length)
    router.patch('/').handler(length)
    router.delete('/').handler(length)
    return serve(router)
  }

  // `fetch` measures every body it sends, an empty one included.
  it.each([
    ['an empty string', ''],
    ['an empty Uint8Array', new Uint8Array()],
    ['an empty Blob', new Blob([])],
  ])('sends %s under a Content-Length of 0', async (_, body) => {
    const server = await serveLengths()

    expect(await (await server.request('/length', { method: 'POST', body })).json()).toEqual({ length: '0' })
  })

  // `fetch` measures a request with no body itself, whatever length it declares: `0` for a method that expects a body,
  // none for any other, and none for one sent chunked.
  it.each([
    ['a POST', { method: 'POST' }, '0'],
    ['a PUT', { method: 'PUT' }, '0'],
    ['a PATCH', { method: 'PATCH' }, '0'],
    ['a GET', { method: 'GET' }, null],
    ['a DELETE', { method: 'DELETE' }, null],
    ['a POST declaring 5 bytes', { method: 'POST', headers: { 'content-length': '5' } }, '0'],
    ['a GET declaring 5 bytes', { method: 'GET', headers: { 'content-length': '5' } }, null],
    [
      'a chunked POST',
      { method: 'POST', headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' } },
      null,
    ],
  ])('sends %s with no body under the Content-Length fetch writes', async (_, init, length) => {
    const server = await serveLengths()

    expect(await (await server.request('/length', init)).json()).toEqual({ length })
  })
})
