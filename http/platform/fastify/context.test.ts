import { once } from 'node:events'
import { type ClientHttp2Session, connect as connectH2, constants } from 'node:http2'
import { connect } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { $p } from '../../core/routing/picker.js'
import { Args, Controller, Post, Router, type IContext, type WebApplication } from '../../index.js'
import { createWebApplication, newRouter } from './index.js'

/**
 * `ctx.signal` is the request's own: it aborts when the client leaves before the answer is out, and on a timed route
 * when the handler outlives its timeout. Every test of it runs over a socket, since only there does Node close a
 * request as soon as its body has been read, which is not the client leaving.
 */

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function listen(build: (app: WebApplication) => WebApplication = a => a): Promise<string> {
  app = build(createWebApplication().server(() => ({ listener: { host: '127.0.0.1', port: 0 } })) as WebApplication)
  const { address } = await app.run()
  return address.origin
}

// Far more than a socket's buffers hold, so the answer is still flushing when its client goes.
const large = (): Buffer => Buffer.alloc(64 * 1024 * 1024)

const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' } as const

// Resolves once Node has closed the raw request, which it does as soon as the body has been read.
async function requestClosed(ctx: IContext): Promise<void> {
  const raw = ctx.platform.request.raw
  if (!raw.closed) {
    await once(raw, 'close')
  }
}

describe('the request signal', () => {
  // A handler that passes the signal on, to a call of its own, must not see that call cancelled before it starts.
  it('stays open while the handler runs, once the body of a POST has been read', async () => {
    const router = new Router('/read')
    router.post('/').handler(async ctx => {
      // Read first, as a handler that hands it on does: a signal first read after the close never heard it.
      const signal = ctx.signal
      await requestClosed(ctx)
      return { aborted: signal.aborted }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)

    const res = await fetch(`${origin}/read`, json)

    expect(await res.json()).toEqual({ aborted: false })
  })

  it('is the same open signal through $p.signal(), on a POST with a body', async () => {
    @Controller('/picked')
    class PickedController {
      @Post('/')
      @Args([$p.signal(), $p.context()])
      async picked(signal: AbortSignal, ctx: IContext) {
        await requestClosed(ctx)
        return { aborted: signal.aborted, same: signal === ctx.signal }
      }
    }
    void [PickedController]
    const origin = await listen()

    const res = await fetch(`${origin}/picked`, json)

    expect(await res.json()).toEqual({ aborted: false, same: true })
  })

  // What lets a handler stop the work it started for a client that is gone.
  it('aborts when the client leaves while the handler runs', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const held = Promise.withResolvers<void>()
    const router = new Router('/left')
    router.post('/').handler(async ctx => {
      const signal = ctx.signal
      await requestClosed(ctx)
      started.resolve(signal)
      await held.promise
      return { ok: true }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)
    const client = new AbortController()

    try {
      const call = fetch(`${origin}/left`, { ...json, signal: client.signal })
      const signal = await started.promise
      expect(signal.aborted).toBe(false)

      const aborted = once(signal, 'abort')
      client.abort()

      await expect(call).rejects.toThrow()
      await aborted
      expect(signal.aborted).toBe(true)
    } finally {
      held.resolve()
    }
  })

  // Node has taken the whole answer once its end is written, but has not sent it: a client gone before then never got
  // it, and the work behind it is as wasted as for one that left while the handler ran.
  it('aborts when the client resets the connection while a large answer is still flushing', async () => {
    const closed = Promise.withResolvers<AbortSignal>()
    const router = new Router('/large')
    router.get('/').handler(ctx => {
      const signal = ctx.signal
      ctx.platform.reply.raw.once('close', () => closed.resolve(signal))
      return large()
    })
    const { hostname, port } = new URL(await listen(a => a.mount(router) as WebApplication))

    const socket = connect(Number(port), hostname)
    socket.on('error', () => undefined)
    await once(socket, 'connect')
    socket.write(`GET /large HTTP/1.1\r\nHost: ${hostname}\r\n\r\n`)
    await once(socket, 'data')
    socket.resetAndDestroy()

    const signal = await closed.promise
    expect(signal.aborted).toBe(true)
  })

  // Work a handler started that outlives its answer, such as a notice sent after it, belongs to no client that left.
  it('never aborts on a request answered in full', async () => {
    const closed = Promise.withResolvers<AbortSignal>()
    const router = new Router('/answered')
    router.post('/').handler(async ctx => {
      const signal = ctx.signal
      ctx.platform.reply.raw.once('close', () => closed.resolve(signal))
      await requestClosed(ctx)
      return { ok: true }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)

    const res = await fetch(`${origin}/answered`, json)
    expect(await res.json()).toEqual({ ok: true })

    const signal = await closed.promise
    expect(signal.aborted).toBe(false)
  })

  // `app.request(...)` answers through no socket, and its response closes before it reports itself finished.
  it('never aborts on a request answered in full in-process', async () => {
    const closed = Promise.withResolvers<AbortSignal>()
    const router = new Router('/answered-in-process')
    router.post('/').handler(ctx => {
      const signal = ctx.signal
      ctx.platform.reply.raw.once('close', () => closed.resolve(signal))
      return { ok: true }
    })
    app = createWebApplication().mount(router) as WebApplication
    await app.bootstrap()

    const res = await app.request('/answered-in-process', json)
    expect(await res.json()).toEqual({ ok: true })

    const signal = await closed.promise
    expect(signal.aborted).toBe(false)
  })

  it("aborts with the handler timeout's reason on a timed route", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const held = Promise.withResolvers<void>()
    const router = new Router('/timed')
    router.get('/').handler(async ctx => {
      started.resolve(ctx.signal)
      await held.promise
      return { late: true }
    })
    const origin = await listen(
      a => a.server(() => ({ factory: { handlerTimeout: 30 } })).mount(router) as WebApplication,
    )

    try {
      const res = await fetch(`${origin}/timed`)
      const signal = await started.promise

      expect(res.status).toBe(503)
      expect(signal.aborted).toBe(true)
      expect((signal.reason as { code?: string }).code).toBe('FST_ERR_HANDLER_TIMEOUT')
    } finally {
      held.resolve()
    }
  })

  // Read late, as work a handler started may first read it: it tells what became of the answer all the same.
  it('is aborted when first read after the client left', async () => {
    const started = Promise.withResolvers<IContext>()
    const held = Promise.withResolvers<void>()
    const router = new Router('/left-unread')
    router.post('/').handler(async ctx => {
      started.resolve(ctx)
      await held.promise
      return { ok: true }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)
    const client = new AbortController()

    try {
      const call = fetch(`${origin}/left-unread`, { ...json, signal: client.signal })
      const ctx = await started.promise
      const closed = once(ctx.platform.reply.raw, 'close')
      client.abort()
      await expect(call).rejects.toThrow()
      await closed

      expect(ctx.signal.aborted).toBe(true)
    } finally {
      held.resolve()
    }
  })

  it('stays open when first read after a full answer', async () => {
    const closed = Promise.withResolvers<IContext>()
    const router = new Router('/answered-unread')
    router.post('/').handler(ctx => {
      ctx.platform.reply.raw.once('close', () => closed.resolve(ctx))
      return { ok: true }
    })
    const origin = await listen(a => a.mount(router) as WebApplication)

    const res = await fetch(`${origin}/answered-unread`, json)
    expect(await res.json()).toEqual({ ok: true })

    const ctx = await closed.promise
    expect(ctx.signal.aborted).toBe(false)
  })

  // Fastify's own signal on a timed route aborts when the body has been read too: only its timeout is the handler's.
  it('stays open on a timed route once the body of a POST has been read', async () => {
    const router = new Router('/timed-read')
    router.post('/').handler(async ctx => {
      const signal = ctx.signal
      await requestClosed(ctx)
      return { aborted: signal.aborted }
    })
    const origin = await listen(
      a => a.server(() => ({ factory: { handlerTimeout: 60_000 } })).mount(router) as WebApplication,
    )

    const res = await fetch(`${origin}/timed-read`, json)

    expect(await res.json()).toEqual({ aborted: false })
  })

  it("is aborted with the timeout's reason when first read after the handler timeout fired", async () => {
    const started = Promise.withResolvers<IContext>()
    const held = Promise.withResolvers<void>()
    const router = new Router('/timed-unread')
    router.get('/').handler(async ctx => {
      started.resolve(ctx)
      await held.promise
      return { late: true }
    })
    const origin = await listen(
      a => a.server(() => ({ factory: { handlerTimeout: 30 } })).mount(router) as WebApplication,
    )

    try {
      const res = await fetch(`${origin}/timed-unread`)
      const ctx = await started.promise

      expect(res.status).toBe(503)
      expect(ctx.signal.aborted).toBe(true)
      expect((ctx.signal.reason as { code?: string }).code).toBe('FST_ERR_HANDLER_TIMEOUT')
    } finally {
      held.resolve()
    }
  })
})

// An HTTP/2 client leaves by cancelling its stream, and the connection stays up. Node reports such a response finished,
// with `writableFinished` while its handler runs and with a `finish` event while it flushes, so neither tells a stream
// the client cancelled from an answer it got.
describe('the request signal over HTTP/2', () => {
  let session: ClientHttp2Session | undefined

  afterEach(() => {
    session?.destroy()
    session = undefined
  })

  // Runs `answer` as the handler of GET /h2, with the signal read first, and cancels the stream once the handler has
  // started or once the answer's first bytes arrived. Resolves with the signal when the response closes.
  async function cancelled(answer: () => unknown, cancelOn: 'started' | 'data'): Promise<AbortSignal> {
    const started = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<AbortSignal>()
    const router = new Router('/h2')
    router.get('/').handler(ctx => {
      const signal = ctx.signal
      ctx.platform.reply.raw.once('close', () => closed.resolve(signal))
      started.resolve()
      return answer()
    })
    app = createWebApplication()
      .server(() => ({ factory: { http2: true }, listener: { host: '127.0.0.1', port: 0 } }))
      .mount(router) as WebApplication
    const { address } = await app.run()

    session = connectH2(address.origin)
    const stream = session.request({ ':path': '/h2' })
    stream.on('error', () => undefined)
    await (cancelOn === 'started' ? started.promise : once(stream, 'data'))
    stream.close(constants.NGHTTP2_CANCEL)

    return closed.promise
  }

  it('aborts when the client cancels its stream while the handler runs', async () => {
    const held = Promise.withResolvers<void>()
    try {
      const signal = await cancelled(async () => {
        await held.promise
        return { ok: true }
      }, 'started')

      expect(signal.aborted).toBe(true)
    } finally {
      held.resolve()
    }
  })

  it('aborts when the client cancels its stream while a large answer is still flushing', async () => {
    const signal = await cancelled(large, 'data')

    expect(signal.aborted).toBe(true)
  })
})

function helpers() {
  return newRouter('/helpers')
    .get('/bad-request', ctx => {
      ctx.badRequest()
    })
    .get('/not-found', ctx => {
      ctx.notFound()
    })
    .get('/unprocessable-content', ctx => {
      ctx.unprocessableContent()
    })
    .get('/not-found-with-body', ctx => {
      ctx.notFound({ reason: 'no such pet' })
    })
}

describe('Context error helpers', () => {
  // The same problem a thrown error renders to, so a client parses one shape whichever way the handler failed.
  it.each([
    ['bad-request', 400, 'Bad Request', 'ERR_HTTP_BAD_REQUEST'],
    ['not-found', 404, 'Not Found', 'ERR_HTTP_NOT_FOUND'],
    ['unprocessable-content', 422, 'Unprocessable Content', 'ERR_HTTP_UNPROCESSABLE_CONTENT'],
  ])('answers /%s without a body with a problem', async (path, status, title, code) => {
    const app = createWebApplication().mount(helpers())
    await app.bootstrap()

    const res = await app.request(`/helpers/${path}`)

    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title,
      status,
      detail: title,
      code,
      correlation_id: expect.stringMatching(/^req-/),
      timestamp: expect.any(String),
    })

    await app.close()
  })

  // The same negotiation as a thrown error: an agent asking for Markdown gets it from a helper too.
  it('answers a helper without a body in the format the client asked for', async () => {
    const app = createWebApplication().mount(helpers())
    await app.bootstrap()

    const res = await app.request('/helpers/not-found', { headers: { accept: 'text/markdown' } })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(await res.text()).toContain('# Not Found\n\n## What happened\n\nNot Found\n')

    await app.close()
  })

  // A body the handler wrote is its own: no problem fields join it, and it is not relabelled as one.
  it('sends a body it was given as it stands, under its own media type', async () => {
    const app = createWebApplication().mount(helpers())
    await app.bootstrap()

    const res = await app.request('/helpers/not-found-with-body')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ reason: 'no such pet' })

    await app.close()
  })
})

describe('ContextRequest.id', () => {
  // The ID the request's log lines carry, so a handler can hand it to a downstream call or a support page.
  it('is the ID the server gave the request, taken from the header the server was told to trust', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .mount(newRouter('/whoami').get('/', ctx => ({ id: ctx.req.id })))
    await app.bootstrap()

    const res = await app.request('/whoami', { headers: { 'x-request-id': 'edge-91' } })

    expect(await res.json()).toEqual({ id: 'edge-91' })

    await app.close()
  })
})
