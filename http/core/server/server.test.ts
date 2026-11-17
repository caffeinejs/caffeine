import { Readable } from 'node:stream'

import { newNoopLogger, type Logger } from '@caffeinejs/application/logger'
import { ErrShutdownTimeout } from '@caffeinejs/application/shutdown'
import { CaffeineIoC, Injectable, Lifetime, Scopes } from '@caffeinejs/di'
import { Day, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { bindTo } from '../../decorators/bind_to.js'
import { Catch, Controller, Get, Prefix } from '../../decorators/index.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../plugin.js'
import { kRouteConstraints } from '../constraints/keys.js'
import { ErrConfiguration } from '../error/common.js'
import type { ErrorHandler } from '../error/handler.js'
import { ErrHTTPServiceUnavailable } from '../error/http.js'
import type { Guard } from '../guards/guard.js'
import { ErrRouteConflict } from '../matcher/matcher.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { Context } from './context.js'

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>
type FetchApp = WebApplication<any, any, any>

// Served by every application of this file: each test reaches it at its own paths.
class ErrBoom extends Error {}

@Prefix('/v1')
@Controller('/')
class PrefixedRoot {
  @Get('/')
  root(): string {
    return 'root'
  }
}

@Controller('/catching')
class Catching {
  @Get('/')
  boom(): never {
    throw new ErrBoom('boom')
  }

  @Catch(ErrBoom)
  caught(_ctx: IContext, err: ErrBoom): object {
    return { caught: err.message }
  }
}
void [PrefixedRoot, Catching]

let serviceCounter = 0

@Lifetime(Scopes.REQUEST)
@Injectable()
class RequestScopedService {
  readonly id = ++serviceCounter
}

@Lifetime(Scopes.TRANSIENT)
@Controller('/transient-ctrl', [RequestScopedService])
class TransientController {
  constructor(private readonly svc: RequestScopedService) {}

  @Get('/svc-id')
  get(): object {
    return { id: this.svc.id }
  }
}
void [TransientController]

@Injectable()
class DenyGuard implements Guard {
  guard(): boolean {
    return false
  }
}

let app: FetchApp | undefined

afterEach(async () => {
  vi.useRealTimers()
  await app?.close().catch(() => undefined)
  app = undefined
})

async function serve(router: AnyRouter, configure: (app: FetchApp) => FetchApp = a => a): Promise<FetchApp> {
  app = configure(createWebApplication().mount(router))
  await app.bootstrap()
  return app
}

function fetchOn(served: FetchApp, path: string, init?: RequestInit) {
  return served.fetch(new Request(`http://localhost${path}`, init))
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

function capturing(): Logger & { readonly error: Mock; readonly warn: Mock } {
  const error = vi.fn()
  const warn = vi.fn()
  return Object.assign({ ...newNoopLogger() }, { error, warn })
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('HTTPServer', () => {
  // No promise is created on the way: the runtime gets its answer in the tick it asked.
  it('answers a synchronous GET in the tick it arrived', async () => {
    const served = await serve(new Router('/s').get('/').handler(() => 'now'))

    const res = fetchOn(served, '/s')

    expect(res).toBeInstanceOf(Response)
    expect(await (res as Response).text()).toBe('now')
  })

  it('answers 404 through the error chain for an unknown route', async () => {
    const res = await fetchOn(await serve(new Router('/s')), '/nowhere')

    expect(res.status).toBe(404)
    const problem = (await res.json()) as { code: string; detail: string }
    expect(problem.code).toBe('ERR_HTTP_NOT_FOUND')
    expect(problem.detail).toBe('Route GET:/nowhere not found')
  })

  it('answers 400 for a path that cannot be decoded', async () => {
    const served = await serve(new Router('/s').get('/:p').handler(ctx => ctx.req.param('p')))

    expect((await fetchOn(served, '/s/%E0%A4%A')).status).toBe(400)
  })

  it('serves HEAD for a GET route with the length and no body', async () => {
    const served = await serve(new Router('/s').get('/').handler(() => 'héllo'))

    const res = await fetchOn(served, '/s', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('6')
    expect(await res.text()).toBe('')
  })

  // A cache updates the response it stored with the headers of a 304, so a length there would tell it the
  // representation is now empty; a 204 has no content to measure.
  it.each([304, 204])('answers HEAD with %i and no body with no Content-Length', async status => {
    const served = await serve(
      new Router('/s').get('/bodyless').handler(ctx => {
        ctx.status(status)
        return undefined
      }),
    )

    const res = await fetchOn(served, '/s/bodyless', { method: 'HEAD' })

    expect(res.status).toBe(status)
    expect(res.headers.get('content-length')).toBe(null)
    expect(res.headers.get('content-type')).toBe(null)
  })

  // The length a HEAD reports is that of the GET's body: an empty one is 0.
  it('answers HEAD with 200 and an empty body with Content-Length 0', async () => {
    const served = await serve(new Router('/s').get('/empty').handler(() => undefined))

    const res = await fetchOn(served, '/s/empty', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('0')
  })

  // A Node stream an answer carries reaches onSend as a web stream, and a web stream onSend returns goes out.
  it('hands onSend a web stream for a streamed answer and sends the stream it returns', async () => {
    let handed: unknown
    const served = await serve(
      new Router('/stream').get('/').handler(() => Readable.from(['a', 'b'])),
      a =>
        a.hook('onSend', (_ctx, payload) => {
          handed = payload
          return new Response('replaced').body
        }),
    )

    const res = await fetchOn(served, '/stream')

    expect(await res.text()).toBe('replaced')
    expect(handed).toBeInstanceOf(ReadableStream)
  })

  it('gives a transient controller a fresh request-scoped service per request', async () => {
    app = createWebApplication()
    await app.bootstrap()

    const r1 = await fetchOn(app, '/transient-ctrl/svc-id')
    const r2 = await fetchOn(app, '/transient-ctrl/svc-id')

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect((await r2.json()) as { id: number }).toEqual({ id: ((await r1.json()) as { id: number }).id + 1 })
  })

  it("keeps an explicit HEAD route over the GET's twin, in either order", async () => {
    const router = new Router('/h')
    router
      .head('/first')
      .header('x-head', 'explicit')
      .handler(() => undefined)
    router.get('/first').handler(() => 'get')
    router.get('/last').handler(() => 'get')
    router
      .head('/last')
      .header('x-head', 'explicit')
      .handler(() => undefined)
    const served = await serve(router)

    for (const path of ['/h/first', '/h/last']) {
      expect((await fetchOn(served, path, { method: 'HEAD' })).headers.get('x-head')).toBe('explicit')
    }
  })

  it('registers a prefixed root at the prefix and with a trailing slash', async () => {
    const served = await serve(new Router('/s'))

    expect(await (await fetchOn(served, '/v1')).text()).toBe('root')
    expect(await (await fetchOn(served, '/v1/')).text()).toBe('root')
  })

  it('strips the base path, and routes a request without it as it came', async () => {
    const served = await serve(
      new Router('/s').get('/').handler(ctx => ctx.req.basePath),
      a => a.basePath('/api'),
    )

    expect(await (await fetchOn(served, '/api/s')).text()).toBe('/api')
    expect(await (await fetchOn(served, '/s')).text()).toBe('')
  })

  it('answers 503 when a route outlives its timeout and drops the late result', async () => {
    const logger = capturing()
    const held = latch()
    let signal: AbortSignal | undefined
    const served = await serve(
      new Router('/s')
        .get('/slow')
        .timeout(50 * Millisecond)
        .handler(async ctx => {
          signal = ctx.signal
          await held.promise
          return 'late'
        }),
      a => a.logger(b => b.use(logger)),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = fetchOn(served, '/s/slow')
    await vi.advanceTimersByTimeAsync(50)
    const res = await pending

    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('ERR_HTTP_SERVICE_UNAVAILABLE')
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBeInstanceOf(ErrHTTPServiceUnavailable)

    held.release()
    await tick()

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      'Handler settled after its timeout',
    )
    vi.useRealTimers()
    await served.close()
    app = undefined
  })

  // The 503 stands once the timer fired, even while an asynchronous catch handler is still writing it.
  it('drops a handler result that settles while a catch handler answers the timeout', async () => {
    const handlerHeld = latch()
    const catchHeld = latch()
    @Catch(ErrHTTPServiceUnavailable)
    class SlowTimeoutHandler implements ErrorHandler<ErrHTTPServiceUnavailable> {
      async handle(ctx: IContext): Promise<unknown> {
        await catchHeld.promise
        return ctx.status(503).body({ caught: true })
      }
    }
    const served = await serve(
      new Router('/s')
        .get('/slow')
        .timeout(50 * Millisecond)
        .handler(async () => {
          await handlerHeld.promise
          return 'late'
        }),
      a => a.errorHandling(e => e.globalHandlers(SlowTimeoutHandler)),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = fetchOn(served, '/s/slow')
    await vi.advanceTimersByTimeAsync(50)
    handlerHeld.release()
    await vi.advanceTimersByTimeAsync(0)
    catchHeld.release()
    const res = await pending

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ caught: true })
  })

  it("answers 503 under the server's handlerTimeout", async () => {
    const held = latch()
    const served = await serve(
      new Router('/s').get('/slow').handler(async () => {
        await held.promise
        return 'late'
      }),
      a => a.server(() => ({ handlerTimeout: 20 * Millisecond })),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = fetchOn(served, '/s/slow')
    await vi.advanceTimersByTimeAsync(20)

    expect((await pending).status).toBe(503)
    held.release()
  })

  it('times nothing for a synchronous handler', async () => {
    const served = await serve(
      new Router('/s')
        .get('/')
        .timeout(1 * Second)
        .handler(() => 'now'),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await fetchOn(served, '/s')

    expect(vi.getTimerCount()).toBe(0)
  })

  // Fastify sends at `ctx.body`, so a handler may keep writing into the stream it answered with.
  it('sends the answer at ctx.body while the handler keeps writing into the stream', async () => {
    const served = await serve(
      new Router('/s')
        .get('/sse')
        .timeout(1 * Second)
        .handler(async ctx => {
          const stream = new TransformStream<string, string>()
          ctx.body(stream.readable)
          const writer = stream.writable.getWriter()
          await writer.write('a')
          await writer.write('b')
          await writer.close()
        }),
    )

    const res = await fetchOn(served, '/s/sse')

    expect(await res.text()).toBe('ab')
  })

  it('logs a throw after the answer and keeps the answer', async () => {
    const logger = capturing()
    const served = await serve(
      new Router('/s').get('/').handler(async ctx => {
        ctx.body('x')
        await Promise.resolve()
        throw new Error('after')
      }),
      a => a.logger(b => b.use(logger)),
    )

    const res = await fetchOn(served, '/s')
    await tick()

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('x')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Handler failed after its answer was sent')
  })

  it('ignores a header written after the answer', async () => {
    const logger = capturing()
    const served = await serve(
      new Router('/s').get('/').handler(async ctx => {
        ctx.body('x')
        await Promise.resolve()
        ctx.header('x-late', '1')
      }),
      a => a.logger(b => b.use(logger)),
    )

    const res = await fetchOn(served, '/s')
    await tick()

    expect(res.headers.get('x-late')).toBe(null)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  // The answer is final at ctx.body whichever way the handler runs, as Fastify sends it there.
  it('ignores a header a synchronous handler writes after the answer', async () => {
    const logger = capturing()
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        ctx.body('x')
        ctx.header('x-late', '1')
      }),
      a => a.logger(b => b.use(logger)),
    )

    const res = await fetchOn(served, '/s')

    expect(res.headers.get('x-late')).toBe(null)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('logs a synchronous throw after the answer as the asynchronous one is, and keeps the answer', async () => {
    const logger = capturing()
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        ctx.body('x')
        throw new Error('after')
      }),
      a => a.logger(b => b.use(logger)),
    )

    const res = await fetchOn(served, '/s')

    expect(await res.text()).toBe('x')
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Handler failed after its answer was sent')
  })

  it("runs a route's guards before its handler and answers their denial", async () => {
    const handler = vi.fn(() => 'reached')
    const served = await serve(new Router('/s').guards([DenyGuard]).get('/').handler(handler))

    const res = await fetchOn(served, '/s')

    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it("resolves a controller's @Catch method on the instance the request used", async () => {
    const res = await fetchOn(await serve(new Router('/s')), '/catching')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ caught: 'boom' })
  })

  it('resolves Context from the container within the request', async () => {
    let same: boolean | undefined
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        same = served.container.get(Context) === (ctx as unknown as Context)
        return 'ok'
      }),
    )

    await fetchOn(served, '/s')

    expect(same).toBe(true)
  })

  // A field that describes the connection is the platform's to write, never the handler's.
  it.each<[string, Record<string, string>, string[], string[]]>([
    [
      'the fixed list',
      { 'keep-alive': 'timeout=5', 'transfer-encoding': 'chunked', 'x-kept': '1' },
      ['x-kept'],
      ['keep-alive', 'transfer-encoding'],
    ],
    [
      'what Connection names',
      { connection: 'x-hop', 'x-hop': '1', 'x-kept': '1' },
      ['x-kept'],
      ['connection', 'x-hop'],
    ],
  ])('drops the headers that describe a connection: %s', async (_case, set, kept, dropped) => {
    const served = await serve(new Router('/s').get('/').handler(ctx => ctx.headers(set).body('ok')))

    const res = await fetchOn(served, '/s')

    expect(kept.map(name => res.headers.get(name))).toEqual(kept.map(() => '1'))
    expect(dropped.map(name => res.headers.get(name))).toEqual(dropped.map(() => null))
  })

  // The answer has left when the scope ends: a destroy hook that fails is reported, not answered.
  it('logs a request scope whose destroy hook fails, and still answers', async () => {
    class Session {}
    const logger = capturing()
    const container = new CaffeineIoC()
    container.bind(Session, t =>
      t
        .toSelf()
        .lifetime(Scopes.REQUEST)
        .preDestroy(() => {
          throw new Error('the session would not close')
        }),
    )
    const router = new Router('/s')
    router
      .get('/')
      .inject(i => ({ session: i.provide(Session) }))
      .handler((_ctx, deps) => {
        deps.session.get()
        return 'ok'
      })
    app = createWebApplication({ container })
      .logger(b => b.use(logger))
      .mount(router)
    await app.bootstrap()

    const res = await fetchOn(app, '/s')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(AggregateError) }),
        'Cannot tear down the request scope',
      ),
    )
  })

  it.each<[string, (router: AnyRouter) => void]>([
    [
      'a schema that is neither a TypeBox schema nor a Standard Schema',
      r =>
        void r
          .get('/x')
          .schema({ querystring: { type: 'object' } } as never)
          .handler(() => 'x'),
    ],
    [
      'a constraint',
      r =>
        void r
          .get('/x')
          .config(kRouteConstraints, { version: '1.0.0' })
          .handler(() => 'x'),
    ],
    [
      'a @Timeout of 0',
      r =>
        void r
          .get('/x')
          .timeout(0)
          .handler(() => 'x'),
    ],
    // Past what a timer can wait, a timer fires at once.
    [
      'a @Timeout of 30 days',
      r =>
        void r
          .get('/x')
          .timeout(30 * Day)
          .handler(() => 'x'),
    ],
  ])('refuses %s at start-up', async (_feature, declare) => {
    const router = new Router('/refused')
    declare(router)
    app = createWebApplication().mount(router)

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow('/refused/x')
  })

  it('refuses two routes on one method and path with ErrRouteConflict', async () => {
    app = createWebApplication().mount(
      new Router('/twice').get('/').handler(() => 'a'),
      new Router('/twice').get('/').handler(() => 'b'),
    )

    await expect(app.bootstrap()).rejects.toThrow(ErrRouteConflict)
  })

  it('answers 503 through the error chain while closing, and close() waits for the request in flight', async () => {
    const started = latch()
    const held = latch()
    const router = new Router('/s')
    router.get('/slow').handler(async () => {
      started.release()
      await held.promise
      return 'done'
    })
    router.get('/fast').handler(() => 'fast')
    const served = await serve(router, a => a.shutdown(s => s.drainDelay(0)))

    const first = fetchOn(served, '/s/slow')
    await started.promise
    let closed = false
    const closing = served.close().then(() => {
      closed = true
    })
    await tick()

    const second = await fetchOn(served, '/s/fast')
    expect(second.status).toBe(503)
    expect(((await second.json()) as { code: string }).code).toBe('ERR_HTTP_SERVICE_UNAVAILABLE')
    expect(closed).toBe(false)

    held.release()
    await closing
    expect(await (await first).text()).toBe('done')
    app = undefined
  })

  it('answers a plain 503 after close, without the container', async () => {
    const served = await serve(new Router('/s').get('/').handler(() => 'ok'))
    await served.close()
    app = undefined

    const res = await fetchOn(served, '/s')

    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('Service Unavailable')
  })

  it('ends a stalled streamed body when the shutdown budget runs out', async () => {
    const served = await serve(
      new Router('/s').get('/').handler(() => new ReadableStream<Uint8Array>()),
      a => a.shutdown(s => s.drainDelay(0).shutdownTimeout(200 * Millisecond)),
    )
    const res = await fetchOn(served, '/s')
    const read = res.body!.getReader().read()

    const error = await served.close().catch((err: unknown) => err)

    await expect(read).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    app = undefined
  })

  // As Fastify destroys the socket of a request still in flight: the caller's request fails rather than waiting on a
  // handler that never settles, and the request scope ends with it.
  it.each<[string, (served: FetchApp) => Response | Promise<Response>]>([
    ['fetch', served => fetchOn(served, '/s')],
    ['request', served => served.request('/s')],
  ])('fails a stalled %s and aborts its handler when the shutdown budget runs out', async (_entry, send) => {
    const started = latch()
    let signal: AbortSignal | undefined
    const served = await serve(
      new Router('/s').get('/').handler(async ctx => {
        signal = ctx.signal
        started.release()
        await new Promise(() => undefined)
      }),
      a => a.shutdown(s => s.drainDelay(0).shutdownTimeout(200 * Millisecond)),
    )
    const pending = send(served)
    await started.promise

    const error = await served.close().catch((err: unknown) => err)

    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    await expect(Promise.resolve(pending)).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)
    expect(signal?.aborted).toBe(true)
    app = undefined
  })

  it("does not hang when a listener's handler stalls past the budget", async () => {
    const started = latch()
    const admin = new Router('/admin')
      .extend(bindTo('admin'))
      .get('/')
      .handler(async () => {
        started.release()
        await new Promise(() => undefined)
      })
    app = createWebApplication()
      .listener('admin')
      .mount(admin)
      .shutdown(s => s.drainDelay(0).shutdownTimeout(200 * Millisecond))
    await app.run()
    const pending = app.listeners.get('admin')!.fetch(new Request('http://localhost/admin'))
    await started.promise

    const error = await app.close().catch((err: unknown) => err)

    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    await expect(pending).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)
    app = undefined
  })

  it('rejects when an async route sets a header Headers refuses, logs it, and close() still resolves', async () => {
    const logger = capturing()
    const served = await serve(
      new Router('/s').get('/').handler(async ctx => {
        await Promise.resolve()
        ctx.header('x-a', 'a\r\nb')
        return 'x'
      }),
      a => a.logger(b => b.use(logger)),
    )

    await expect(fetchOn(served, '/s')).rejects.toBeInstanceOf(TypeError)
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Cannot send the answer')
    await served.close()
    app = undefined
  })

  it('throws from app.fetch called inside a request of the same application, logs it, and close() still resolves', async () => {
    const error = vi.fn()
    let inner: unknown
    const router = new Router('/s')
    router.get('/inner').handler(() => 'inner')
    router.get('/outer').handler(() => {
      try {
        void served.fetch(new Request('http://localhost/s/inner'))
      } catch (err) {
        inner = err
      }
      return 'outer'
    })
    const served = await serve(router, a => a.logger(b => b.use({ ...newNoopLogger(), error })))

    await (await fetchOn(served, '/s/outer')).text()

    expect((inner as Error).name).toBe('ErrIllegalScopeState')
    expect(error.mock.calls.map(call => call[1])).toEqual(['Cannot serve the request'])
    await served.close()
    app = undefined
  })
})

describe('HTTPServer hooks', () => {
  // A plugin reads a route's config through `ctx.route`: the engine serves a key it does not know itself.
  it("serves a route whose config key is a plugin's own", async () => {
    const served = await serve(
      new Router('/s')
        .get('/')
        .config('greeting', 'hello')
        .handler(() => 'ok'),
      a => a.hook('onSend', ctx => void ctx.header('x-greeting', String(ctx.route?.config.get('greeting')))),
    )

    const res = await fetchOn(served, '/s')

    expect(res.headers.get('x-greeting')).toBe('hello')
  })

  // `onRoute` reads the route; the guards it declared were taken before, so a hook cannot drop them.
  it('keeps a guard an onRoute hook tried to drop', async () => {
    const served = await serve(
      new Router('/s')
        .guards([DenyGuard])
        .get('/')
        .handler(() => 'ok'),
      a =>
        a.hook('onRoute', route => {
          ;(route.route as { guards?: unknown[] }).guards = []
        }),
    )

    const res = await fetchOn(served, '/s')

    expect(res.status).toBe(403)
  })

  // Once the timeout answered 503, the request is over: a later point must not act on it.
  it('runs no preHandler after the timeout answered', async () => {
    const held = latch()
    const preHandler = vi.fn()
    const served = await serve(
      new Router('/s')
        .get('/')
        .timeout(50 * Millisecond)
        .hook('onRequest', () => held.promise)
        .hook('preHandler', preHandler)
        .handler(() => 'late'),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = fetchOn(served, '/s')
    await vi.advanceTimersByTimeAsync(50)
    const res = await pending
    held.release()
    vi.useRealTimers()
    await tick()

    expect(res.status).toBe(503)
    expect(preHandler).toHaveBeenCalledTimes(0)
  })

  // onResponse runs inside the request: what the request resolved is still there to read.
  it('lets onResponse resolve a request-scoped dependency', async () => {
    class Session {
      readonly id = Math.random()
    }
    const ran = latch()
    const ids: number[] = []
    const container = new CaffeineIoC()
    container.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))

    app = createWebApplication({ container })
      .hook('onRequest', () => void ids.push(container.get(Session).id))
      .hook('onResponse', () => {
        ids.push(container.get(Session).id)
        ran.release()
      })
      .mount(new Router('/s').get('/').handler(() => 'ok'))
    await app.bootstrap()

    await (await fetchOn(app, '/s')).text()
    await ran.promise

    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
  })

  // onClose sees a server with nothing in flight: what it closes, nothing still serving needs.
  it('runs onClose only once a held request is answered', async () => {
    const held = latch()
    const closed = vi.fn()
    const served = await serve(
      new Router('/s').get('/').handler(async () => {
        await held.promise
        return 'ok'
      }),
      a => a.hook('onClose', closed),
    )

    const pending = fetchOn(served, '/s')
    const closing = served.close()
    await tick()

    expect(closed).toHaveBeenCalledTimes(0)

    held.release()
    await (await pending).text()
    await closing
    app = undefined

    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('HTTPServer middleware', () => {
  // A middleware mounted under a path sees the rest of the URL; once it answers, what runs after it sees the request's.
  it('hands the request its URL back when a mounted middleware answers without next', async () => {
    const seen: string[] = []
    const served = await serve(
      new Router('/admin').get('/users').handler(() => 'handler'),
      a =>
        a
          .use('/admin', ctx => {
            ctx.body('denied')
          })
          .hook('onSend', ctx => void seen.push(ctx.req.url)),
    )

    const res = await fetchOn(served, '/admin/users')

    expect(await res.text()).toBe('denied')
    expect(seen).toEqual(['/admin/users'])
  })
})

/**
 * What the caching package does to a server and a route, without the package: a plugin registered under its name, and
 * a `cache` entry in the route's config. The plugin adds a hook, as the real one does, so its batch is kept.
 */
describe('a route that declares caching', () => {
  class Caching extends HTTPPlugin {
    override readonly name = '@caffeinejs/caching'

    register(context: HTTPSetupContext): void {
      context.app.hook('onRoute', () => {})
    }
  }

  const caching = () => new Caching()
  function cached<R extends AnyRouter>(router: R): R {
    router
      .get('/x')
      .config('cache', { ttl: 60 * Second })
      .handler(() => 'x')
    return router
  }

  async function failure(): Promise<unknown> {
    return app!.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )
  }

  // It would answer every request as if it declared nothing.
  it('is refused when nothing installed caching', async () => {
    app = createWebApplication().mount(cached(new Router('/cache-none')))

    const err = await failure()

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect((err as Error).message).toContain(
      'Cannot serve "GET /cache-none/x" on the fetch application: it declares @CacheControl or @CacheInvalidate and no HTTP caching covers it',
    )
  })

  it('starts when the application installed caching', async () => {
    app = createWebApplication()
      .with(caching)
      .mount(cached(new Router('/cache-root')))
    await app.bootstrap()

    expect((await fetchOn(app, '/cache-root/x')).status).toBe(200)
  })

  // A router's install covers its own routes and says nothing about its sibling's.
  it('starts when its own router installed caching, and still refuses a sibling without it', async () => {
    app = createWebApplication().mount(cached(new Router('/cache-own').with(caching)))
    await app.bootstrap()
    expect((await fetchOn(app, '/cache-own/x')).status).toBe(200)
    await app.close()

    app = createWebApplication().mount(
      cached(new Router('/cache-own').with(caching)),
      cached(new Router('/cache-sibling')),
    )

    const err = await failure()

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect((err as Error).message).toContain('"GET /cache-sibling/x"')
    expect((err as Error).message).toContain('no HTTP caching covers it')
  })

  // Two installs over one route would run two caches, each reporting every outcome.
  it('is refused when its router installed caching under a server that did', async () => {
    const nested = new Router('/cache-twice').with(caching)
    nested.get('/x').handler(() => 'x')
    app = createWebApplication().with(caching).mount(nested)

    const err = await failure()

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect((err as Error).message).toContain('HTTP caching is installed more than once over it')
  })
})
