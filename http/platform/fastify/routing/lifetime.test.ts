import { readFileSync } from 'node:fs'
import { connect, constants } from 'node:http2'
import type { Socket } from 'node:net'

import fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $p, Args, Controller, Post, Router, Timeout, type IContext, type WebApplication } from '../../../index.js'
import { createWebApplication } from '../index.js'
import { requestSignal } from './lifetime.js'

/**
 * A request's signal and its route or server timeout, seen over a real socket. Node closes the raw request of one
 * with a body as soon as the body is read, which an in-process request never does: on Fastify's own signal and
 * timer that close read as the client leaving, so the timeout never fired and the signal aborted under a client
 * still waiting.
 */

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

const json = (method: string, extra: RequestInit = {}): RequestInit => ({
  method,
  body: JSON.stringify({ a: 1 }),
  headers: { 'content-type': 'application/json' },
  ...extra,
})

let app: WebApplication | undefined
// Released after every test, so a handler a failed test left holding does not hold the close.
const holds: Array<() => void> = []

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  }
  for (const release of holds.splice(0)) {
    release()
  }
  await app?.close()
  app = undefined
})

/** A latch the handler awaits until the test lets it go. */
function hold(): PromiseWithResolvers<void> {
  const held = Promise.withResolvers<void>()
  holds.push(() => held.resolve())
  return held
}

/** One turn of the event loop: whatever Node emits on the next tick has been emitted. */
function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

interface Served {
  origin: string
  /** Resolves when the next connection the server accepts closes. */
  closed: () => Promise<void>
}

/**
 * Runs `build`'s application on a real port, then fakes the clock: after the file's first `fetch`, so undici builds
 * its own timers real.
 */
async function serve(build: (app: WebApplication) => unknown): Promise<Served> {
  app = build(createWebApplication() as WebApplication) as WebApplication
  await app.run({ host: '127.0.0.1', port: 0 })

  const origin = `http://127.0.0.1:${app.address!.port}`
  await (await fetch(`${origin}/warm-up`)).arrayBuffer()

  const sockets: Array<Promise<void>> = []
  app.instance.server.on('connection', (socket: Socket) => {
    sockets.push(new Promise(resolve => socket.once('close', () => resolve())))
  })

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  return { origin, closed: () => sockets.at(-1)! }
}

/** Counts every send that reaches the hooks, the timeout's 503 included, but the warm-up's. */
function countSends(runs: { n: number }): FastifyPluginAsync {
  return fp(
    async instance => {
      instance.addHook('onSend', async (request, _reply, payload) => {
        if (request.url !== '/warm-up') {
          runs.n++
        }
        return payload
      })
    },
    { name: 'count-sends' },
  )
}

describe('a request with a body on a timed route', () => {
  it.each(BODY_METHODS)('%s is answered 503 once its route timeout passes', async method => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a.mount(
        new Router('/timed')
          .route(method, '/slow')
          .timeout(50)
          .handler(async () => {
            started.resolve()
            await held.promise
            return 'late'
          }),
      ),
    )

    const answer = fetch(`${origin}/timed/slow`, json(method))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    expect((await answer).status).toBe(503)
  })

  it.each(BODY_METHODS)("%s is answered 503 once the server's handlerTimeout passes", async method => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a
        .server(() => ({ factory: { handlerTimeout: 50 } }))
        .mount(
          new Router('/server-timed').route(method, '/slow').handler(async () => {
            started.resolve()
            await held.promise
            return 'late'
          }),
        ),
    )

    const answer = fetch(`${origin}/server-timed/slow`, json(method))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    expect((await answer).status).toBe(503)
  })

  it('is answered 503 on GET too, which never had the bug', async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a.mount(
        new Router('/get')
          .get('/slow')
          .timeout(50)
          .handler(async () => {
            started.resolve()
            await held.promise
            return 'late'
          }),
      ),
    )

    const answer = fetch(`${origin}/get/slow`)
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    expect((await answer).status).toBe(503)
  })

  // The decorator path compiles to the same route option.
  it('is answered 503 on a @Post method with @Timeout', async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()

    @Controller('/decorated')
    class Decorated {
      @Post('/slow')
      @Timeout(50)
      async slow() {
        started.resolve()
        await held.promise
        return 'late'
      }
    }
    void [Decorated]

    const { origin } = await serve(a => a)

    const answer = fetch(`${origin}/decorated/slow`, json('POST'))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    expect((await answer).status).toBe(503)
  })

  // The timeout aborts the signal with Fastify's own error, which error handlers and late results already read, and
  // the handler resolving behind the 503 starts no second send.
  it('aborts the signal with FST_ERR_HANDLER_TIMEOUT and sends once', async () => {
    const held = hold()
    const started = Promise.withResolvers<AbortSignal>()
    const runs = { n: 0 }
    const { origin } = await serve(a =>
      a
        .with(() => countSends(runs))
        .mount(
          new Router('/reason')
            .post('/slow')
            .timeout(50)
            .handler(async (ctx: IContext) => {
              started.resolve(ctx.signal)
              await held.promise
              return 'late'
            }),
        ),
    )

    const answer = fetch(`${origin}/reason/slow`, json('POST'))
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()
    const res = await answer
    await res.arrayBuffer()
    await turn()

    expect(res.status).toBe(503)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as { code?: string }).code).toBe('FST_ERR_HANDLER_TIMEOUT')
    expect(runs.n).toBe(1)
  })

  // Answered in time: the timer is gone with the request, and nothing is sent over the answer later.
  it('sends nothing once its timeout passes after it was answered', async () => {
    const runs = { n: 0 }
    const { origin } = await serve(a =>
      a
        .with(() => countSends(runs))
        .mount(
          new Router('/fast')
            .post('/answer')
            .timeout(50)
            .handler(() => 'ok'),
        ),
    )

    const first = await fetch(`${origin}/fast/answer`, json('POST'))
    expect(first.status).toBe(200)
    expect(await first.text()).toBe('ok')

    await vi.advanceTimersByTimeAsync(100)

    // The same keep-alive connection serves the next request, not a late 503.
    const second = await fetch(`${origin}/fast/answer`, json('POST'))
    expect(second.status).toBe(200)
    expect(await second.text()).toBe('ok')
    expect(runs.n).toBe(2)
  })

  // A stream already under way cannot be answered 503: its headers are out, so the connection is cut instead.
  it('cuts a streamed answer still running when its timeout passes', async () => {
    const held = hold()
    const { origin } = await serve(a =>
      a.mount(
        new Router('/stream')
          .post('/slow')
          .timeout(50)
          .handler(
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  async start(controller) {
                    controller.enqueue(new TextEncoder().encode('first'))
                    await held.promise
                    controller.enqueue(new TextEncoder().encode('second'))
                    controller.close()
                  },
                }),
              ),
          ),
      ),
    )

    const res = await fetch(`${origin}/stream/slow`, json('POST'))
    expect(res.status).toBe(200)
    const reading = res.text()

    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    await expect(reading).rejects.toThrow()
  })

  // A hijacked reply answers on its own terms: the timer leaves it alone.
  it('leaves a hijacked reply alone', async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a.mount(
        new Router('/hijack')
          .post('/slow')
          .timeout(50)
          .handler(async (ctx: IContext) => {
            const reply = ctx.platform.reply as FastifyReply
            reply.hijack()
            started.resolve()
            await held.promise
            reply.raw.writeHead(200, { 'content-type': 'text/plain' })
            reply.raw.end('hijacked')
          }),
      ),
    )

    const answer = fetch(`${origin}/hijack/slow`, json('POST'))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    const res = await answer
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hijacked')
  })

  // A route a plugin adds straight on Fastify is timed by the server's timeout, as Fastify timed it.
  it("times a route a plugin registers itself with the server's handlerTimeout", async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a
        .server(() => ({ factory: { handlerTimeout: 50 } }))
        .with(() =>
          fp(
            async (instance: FastifyInstance) => {
              instance.post('/raw/slow', async () => {
                started.resolve()
                await held.promise
                return 'late'
              })
            },
            { name: 'raw-route' },
          ),
        ),
    )

    const answer = fetch(`${origin}/raw/slow`, json('POST'))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    expect((await answer).status).toBe(503)
  })

  // Fastify reads a handlerTimeout of 0 as no timeout.
  it('is not timed on a server whose handlerTimeout is 0', async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a
        .server(() => ({ factory: { handlerTimeout: 0 } }))
        .mount(
          new Router('/zero').post('/slow').handler(async () => {
            started.resolve()
            await held.promise
            return 'answered'
          }),
        ),
    )

    const answer = fetch(`${origin}/zero/slow`, json('POST'))
    await started.promise
    await vi.advanceTimersByTimeAsync(60_000)
    held.resolve()

    const res = await answer
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('answered')
  })
})

describe("a request's signal on a request with a body", () => {
  it.each([
    ['a timed route', 50],
    ['an untimed route', undefined],
  ])('stays unaborted on %s once the body is read, while the client waits', async (_, timeout) => {
    const { origin } = await serve(a => {
      const route = new Router('/read').post('/early')
      return a.mount(
        (timeout === undefined ? route : route.timeout(timeout)).handler(async (ctx: IContext) => {
          const signal = ctx.signal
          // Node emits the raw request's close on the tick after the body ends.
          await turn()
          await turn()
          return { aborted: signal.aborted }
        }),
      )
    })

    const res = await fetch(`${origin}/read/early`, json('POST'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ aborted: false })
  })

  it.each([
    ['read before the client leaves', true],
    ['first read after the client left', false],
  ])('aborts when the client leaves, %s', async (_, early) => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<AbortSignal>()
    const { origin, closed } = await serve(a =>
      a.mount(
        new Router('/leave').post('/slow').handler(async (ctx: IContext) => {
          const signal = early ? ctx.signal : undefined
          started.resolve()
          await held.promise
          seen.resolve(signal ?? ctx.signal)
          return 'late'
        }),
      ),
    )

    const client = new AbortController()
    const answer = fetch(`${origin}/leave/slow`, json('POST', { signal: client.signal })).catch(() => undefined)
    await started.promise
    client.abort()
    await answer
    await closed()
    await turn()
    held.resolve()

    const signal = await seen.promise
    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).name).toBe('AbortError')
  })

  // On a timed route the client leaving is a disconnect, not a timeout, and its timer is gone with the request.
  it('aborts as a disconnect on a timed route, and sends nothing once the timeout passes', async () => {
    const held = hold()
    const started = Promise.withResolvers<AbortSignal>()
    const runs = { n: 0 }
    const { origin, closed } = await serve(a =>
      a
        .with(() => countSends(runs))
        .mount(
          new Router('/timed-leave')
            .post('/slow')
            .timeout(50)
            .handler(async (ctx: IContext) => {
              started.resolve(ctx.signal)
              await held.promise
              return 'late'
            }),
        ),
    )

    const client = new AbortController()
    const answer = fetch(`${origin}/timed-leave/slow`, json('POST', { signal: client.signal })).catch(() => undefined)
    const signal = await started.promise
    await turn()
    await turn()
    expect(signal.aborted).toBe(false)

    client.abort()
    await answer
    await closed()
    await turn()

    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).name).toBe('AbortError')

    await vi.advanceTimersByTimeAsync(50)

    expect(runs.n).toBe(0)
    expect((signal.reason as Error).name).toBe('AbortError')
  })

  it('is the very signal the signal() parameter hands a handler', async () => {
    @Controller('/picked')
    class Picked {
      @Post('/signal')
      @Args([$p.context(), $p.signal()])
      async signal(ctx: IContext, signal: AbortSignal) {
        await turn()
        await turn()
        return { same: signal === ctx.signal, aborted: signal.aborted }
      }
    }
    void [Picked]

    const { origin } = await serve(a => a)
    const res = await fetch(`${origin}/picked/signal`, json('POST'))

    expect(await res.json()).toEqual({ same: true, aborted: false })
  })
})

// An in-process request has no socket to lose: answering it is not a client leaving.
describe("an in-process request's signal", () => {
  it('stays unaborted once answered', async () => {
    const kept = Promise.withResolvers<AbortSignal>()
    app = createWebApplication().mount(
      new Router('/in-process').post('/answer').handler((ctx: IContext) => {
        kept.resolve(ctx.signal)
        return 'ok'
      }),
    ) as WebApplication
    await app.bootstrap()

    const res = await app.request('/in-process/answer', json('POST'))
    expect(await res.text()).toBe('ok')
    await turn()
    await turn()

    expect((await kept.promise).aborted).toBe(false)
  })
})

// A route a plugin adds with a `handlerTimeout` of its own keeps it, timed by the adapter rather than by Fastify.
describe("a raw route's own handlerTimeout", () => {
  it('answers a request with a body 503 at its own timeout', async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a.with(() =>
        fp(
          async (instance: FastifyInstance) => {
            instance.post('/raw-own/slow', { handlerTimeout: 50 }, async () => {
              started.resolve()
              await held.promise
              return 'late'
            })
          },
          { name: 'raw-own-timeout' },
        ),
      ),
    )

    const answer = fetch(`${origin}/raw-own/slow`, json('POST'))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    held.resolve()

    expect((await answer).status).toBe(503)
  })

  it("outlasts a shorter server timeout, as Fastify's own did", async () => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const { origin } = await serve(a =>
      a
        .server(() => ({ factory: { handlerTimeout: 50 } }))
        .with(() =>
          fp(
            async (instance: FastifyInstance) => {
              instance.post('/raw-longer/slow', { handlerTimeout: 500 }, async () => {
                started.resolve()
                await held.promise
                return 'answered'
              })
            },
            { name: 'raw-longer-timeout' },
          ),
        ),
    )

    const answer = fetch(`${origin}/raw-longer/slow`, json('POST'))
    await started.promise
    await vi.advanceTimersByTimeAsync(100)
    held.resolve()

    const res = await answer
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('answered')
  })
})

describe('requestSignal', () => {
  it("is the context's signal in a raw hook on a Caffeine server", async () => {
    const fromHook = Promise.withResolvers<AbortSignal>()
    const fromHandler = Promise.withResolvers<AbortSignal>()
    const { origin } = await serve(a =>
      a
        .with(() =>
          fp(
            async (instance: FastifyInstance) => {
              instance.addHook('preHandler', async request => {
                if (request.url === '/hook/signal') {
                  fromHook.resolve(requestSignal(request))
                }
              })
            },
            { name: 'read-signal' },
          ),
        )
        .mount(
          new Router('/hook').post('/signal').handler((ctx: IContext) => {
            fromHandler.resolve(ctx.signal)
            return 'ok'
          }),
        ),
    )

    await (await fetch(`${origin}/hook/signal`, json('POST'))).text()

    expect(await fromHook.promise).toBe(await fromHandler.promise)
  })

  it("is Fastify's own request.signal on a plain Fastify server", async () => {
    const server = fastify()
    let same: boolean | undefined
    server.get('/plain', async request => {
      same = requestSignal(request) === request.signal
      return 'ok'
    })

    try {
      await server.inject({ method: 'GET', url: '/plain' })
    } finally {
      await server.close()
    }

    expect(same).toBe(true)
  })
})

describe('a timed request with a body over HTTP/2', () => {
  const key = readFileSync(new URL('../../../_tests/_testdata/tls/localhost.key', import.meta.url))
  const cert = readFileSync(new URL('../../../_tests/_testdata/tls/localhost.crt', import.meta.url))

  it('is answered 503 once its route timeout passes, its signal untouched until then', async () => {
    const held = hold()
    const started = Promise.withResolvers<AbortSignal>()
    app = createWebApplication()
      .server(() => ({ factory: { http2: true, https: { key, cert } }, listener: { host: '127.0.0.1', port: 0 } }))
      .mount(
        new Router('/h2')
          .post('/slow')
          .timeout(50)
          .handler(async (ctx: IContext) => {
            started.resolve(ctx.signal)
            await held.promise
            return 'late'
          }),
      ) as WebApplication
    await app.run()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const session = connect(app.address!.origin, { ca: cert })
    try {
      const stream = session.request({ ':method': 'POST', ':path': '/h2/slow', 'content-type': 'application/json' })
      const status = new Promise<number>((resolve, reject) => {
        stream.once('response', headers => resolve(Number(headers[':status'])))
        stream.once('error', reject)
      })
      stream.end(JSON.stringify({ a: 1 }))

      const signal = await started.promise
      await turn()
      await turn()
      expect(signal.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(50)
      held.resolve()

      expect(await status).toBe(503)
      stream.resume()
    } finally {
      session.close()
    }
  })

  it.each([
    ['read before the client leaves', true],
    ['first read after the client left', false],
  ])('aborts when the client cancels its stream, %s', async (_, early) => {
    const held = hold()
    const started = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<AbortSignal>()
    const streamClosed = Promise.withResolvers<void>()
    app = createWebApplication()
      .server(() => ({ factory: { http2: true, https: { key, cert } }, listener: { host: '127.0.0.1', port: 0 } }))
      .mount(
        new Router('/h2-leave').post('/slow').handler(async (ctx: IContext) => {
          const signal = early ? ctx.signal : undefined
          ;(ctx.platform.reply as FastifyReply).raw.once('close', () => streamClosed.resolve())
          started.resolve()
          await held.promise
          seen.resolve(signal ?? ctx.signal)
          return 'late'
        }),
      ) as WebApplication
    await app.run()

    const session = connect(app.address!.origin, { ca: cert })
    try {
      const stream = session.request({
        ':method': 'POST',
        ':path': '/h2-leave/slow',
        'content-type': 'application/json',
      })
      stream.on('error', () => undefined)
      stream.end(JSON.stringify({ a: 1 }))

      await started.promise
      // What a client that gives up sends: RST_STREAM with CANCEL.
      stream.close(constants.NGHTTP2_CANCEL)
      await streamClosed.promise
      await turn()
      held.resolve()

      const signal = await seen.promise
      expect(signal.aborted).toBe(true)
      expect((signal.reason as Error).name).toBe('AbortError')
    } finally {
      session.close()
    }
  })
})
