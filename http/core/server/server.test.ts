import { Readable } from 'node:stream'

import { newNoopLogger, type Logger } from '@caffeinejs/application/logger'
import { ErrShutdownTimeout } from '@caffeinejs/application/shutdown'
import { CaffeineIoC, ContextStorage, Injectable, Lifetime, Scopes } from '@caffeinejs/di'
import { Day, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { ErrWaitUntilClosed, type IContext } from '../../context.js'
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
import { fetchPlatform } from './fetch.js'
import { type FetchAdapter, fetchAdapter, kHosting } from './hosting.js'
import type { SendHooks } from './platform.js'
import type { HTTPServer } from './server.js'

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

async function serveEngine(router: AnyRouter): Promise<HTTPServer> {
  let engine!: HTTPServer
  const adapter: FetchAdapter = {
    [kHosting](settings) {
      const hosting = fetchAdapter[kHosting](settings)
      return {
        ...hosting,
        serve(server, context, customize) {
          engine = server
          return hosting.serve(server, context, customize)
        },
      }
    },
  }
  app = createWebApplication({ adapter }).mount(router)
  await app.bootstrap()
  return engine
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

  it('accepts work in onSend after ctx.body and observes refused work from onResponse', async () => {
    const accepted = latch()
    const refused = Promise.withResolvers<void>()
    const failure = new Error('refused work failed')
    const logger = capturing()
    const responded = latch()
    const onClose = vi.fn()
    let reqId: string | undefined
    let waitUntil: IContext['server']['waitUntil']
    let refusal: unknown
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        reqId = ctx.req.id
        ctx.body('ok')
      }),
      a =>
        a
          .logger(b => b.use(logger))
          .shutdown(s => s.drainDelay(0))
          .hook('onSend', ctx => {
            waitUntil = ctx.server.waitUntil!
            waitUntil(accepted.promise)
          })
          .hook('onResponse', () => {
            try {
              waitUntil!(refused.promise)
            } catch (err) {
              refusal = err
            }
            responded.release()
          })
          .hook('onClose', onClose),
    )

    try {
      const res = await served.request('/s')
      expect(await res.text()).toBe('ok')
      await responded.promise
      expect(refusal).toBeInstanceOf(ErrWaitUntilClosed)
      expect(refusal).toMatchObject({
        code: 'ERR_WAIT_UNTIL_CLOSED',
        message: expect.stringContaining('Cannot register background work: the request is no longer accepting work'),
      })

      const closing = served.close()
      await tick()
      expect(onClose).not.toHaveBeenCalled()
      accepted.release()
      await closing
      expect(onClose).toHaveBeenCalledTimes(1)

      refused.reject(failure)
      await tick()
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ reqId, err: failure }, 'Background work failed')
    } finally {
      accepted.release()
      refused.resolve()
    }
  })

  it('drains independent work registered by an already admitted request during graceful shutdown', async () => {
    const admitted = latch()
    const register = latch()
    const held = latch()
    const failure = new Error('one task failed')
    const logger = capturing()
    const onClose = vi.fn()
    let reqId: string | undefined
    const served = await serve(
      new Router('/s').get('/').handler(async ctx => {
        reqId = ctx.req.id
        const waitUntil = ctx.server.waitUntil!
        admitted.release()
        await register.promise
        waitUntil(held.promise)
        waitUntil(Promise.reject(failure))
        return 'ok'
      }),
      a =>
        a
          .logger(b => b.use(logger))
          .shutdown(s => s.drainDelay(0))
          .hook('onClose', onClose),
    )

    try {
      const pending = served.request('/s')
      await admitted.promise
      const closing = served.close()
      await tick()
      register.release()

      expect(await (await pending).text()).toBe('ok')

      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ reqId, err: failure }, 'Background work failed')
      expect(onClose).not.toHaveBeenCalled()

      const closingAgain = served.close()
      held.release()
      await Promise.all([closing, closingAgain])
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      register.release()
      held.release()
    }
  })

  it('answers a plain 503 when the last background task settles during shutdown', async () => {
    const work = latch()
    const errorHook = latch()
    const onError = vi.fn(() => errorHook.promise)
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        ctx.server.waitUntil!(work.promise)
        return 'ok'
      }),
      a => a.shutdown(s => s.drainDelay(0)).hook('onError', onError),
    )

    try {
      expect(await (await served.request('/s')).text()).toBe('ok')
      const closing = served.close()
      await tick()
      const late = work.promise.then(() => served.request('/s'))
      work.release()
      await tick()

      expect(onError).not.toHaveBeenCalled()
      const response = await late
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('Service Unavailable')
      await closing
    } finally {
      work.release()
      errorHook.release()
    }
  })

  it('drains and reports rejected work when the container does not expose context storage', async () => {
    // The request scope owns its storage. This container exposes neither the storage nor its dependent Context binding.
    const container = new CaffeineIoC().overrides(ops => {
      ops.unbind(Context)
      ops.unbind(ContextStorage)
    })
    const work = Promise.withResolvers<void>()
    const logger = capturing()
    const onClose = vi.fn()
    app = createWebApplication({ container })
      .logger(b => b.use(logger))
      .shutdown(s => s.drainDelay(0))
      .hook('onClose', onClose)
      .mount(
        new Router('/s').get('/').handler(ctx => {
          ctx.server.waitUntil!(work.promise)
          return ctx.req.id
        }),
      )
    await app.bootstrap()

    try {
      const response = await app.request('/s')
      expect(response.status).toBe(200)
      const reqId = await response.text()
      const closing = app.close()
      await tick()
      expect(onClose).not.toHaveBeenCalled()
      const err = new Error('task failed')
      work.reject(err)
      await closing
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ reqId, err }, 'Background work failed')
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      work.resolve()
    }
  })

  it('finishes shutdown when reporting a rejected background task throws', async () => {
    const work = Promise.withResolvers<void>()
    const logger = capturing()
    logger.error.mockImplementation(() => {
      throw new Error('log transport failed')
    })
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        ctx.server.waitUntil!(work.promise)
        return 'ok'
      }),
      a => a.logger(b => b.use(logger)).shutdown(s => s.drainDelay(0)),
    )

    try {
      expect(await (await served.request('/s')).text()).toBe('ok')
      const closing = served.close()
      const err = new Error('task failed')
      work.reject(err)
      await closing
      await tick()
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ reqId: expect.any(String), err }, 'Background work failed')
    } finally {
      work.resolve()
    }
  })

  it('cuts unread injected streams without aborting a completed response still running its hook', async () => {
    const held = latch()
    const cancel = latch()
    let signal!: AbortSignal
    const router = new Router('/s')
    router.get('/stream').handler(() => new ReadableStream<Uint8Array>({ cancel: cancel.release }))
    router.get('/done').handler(ctx => {
      signal = ctx.signal
      return 'sent'
    })
    const served = await serve(router, a =>
      a.shutdown(s => s.drainDelay(0)).hook('onResponse', ctx => (ctx.signal === signal ? held.promise : undefined)),
    )

    try {
      await served.request('/s/stream')
      expect(await (await served.request('/s/done')).text()).toBe('sent')
      const closing = served.close()
      await cancel.promise
      expect(signal.aborted).toBe(false)
      held.release()
      await closing
    } finally {
      held.release()
    }
  })

  it.each(['graceful', 'forced'])(
    'cuts an unread injected stream when its adapter registers cancellation during %s shutdown',
    async mode => {
      const register = latch()
      const cancel = vi.fn()
      const platform: typeof fetchPlatform = {
        ...fetchPlatform,
        respond: (native, head, payload, hooks) =>
          fetchPlatform.respond(native, head, payload, {
            sent: hooks.sent,
            cancelWith: cut => void register.promise.then(() => hooks.cancelWith(cut)),
          }),
      }
      const engine = await serveEngine(
        new Router('/s').get('/').handler(() => new ReadableStream<Uint8Array>({ cancel })),
      )
      const response = await engine.serve(platform, new Request('http://localhost/s'), [], true)

      try {
        const closing = engine.close()
        if (mode === 'forced') {
          engine.forceClose()
        }
        expect(cancel).not.toHaveBeenCalled()
        register.release()
        await tick()
        expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(ErrHTTPServiceUnavailable))
        await expect(response.text()).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)
        await closing
      } finally {
        register.release()
        await response.body?.cancel().catch(() => undefined)
      }
    },
  )

  it('cancels only the unread stream and cancels it once when graceful shutdown becomes forced', async () => {
    const router = new Router('/s')
    router.get('/finished').handler(() => new Response('done').body)
    router.get('/unread').handler(() => new ReadableStream<Uint8Array>())
    const engine = await serveEngine(router)
    let hooks!: SendHooks
    const cancel = vi.fn()
    const platform: typeof fetchPlatform = {
      ...fetchPlatform,
      respond(native, head, payload, current) {
        hooks = current
        return fetchPlatform.respond(native, head, payload, {
          sent: current.sent,
          cancelWith: cut =>
            current.cancelWith(reason => {
              cancel(reason)
              cut(reason)
            }),
        })
      },
    }

    const finished = await engine.serve(platform, new Request('http://localhost/s/finished'), [], true)
    expect(await finished.text()).toBe('done')
    const afterFinish = vi.fn()
    hooks.cancelWith(afterFinish)

    const unread = await engine.serve(platform, new Request('http://localhost/s/unread'), [], true)
    const closing = engine.close()
    const afterCut = vi.fn()
    hooks.cancelWith(afterCut)
    engine.forceClose()
    await closing

    await expect(unread.text()).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)
    expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(ErrHTTPServiceUnavailable))
    expect(afterFinish).not.toHaveBeenCalled()
    expect(afterCut).not.toHaveBeenCalled()
  })

  it('keeps registered work pending after the caller aborts its injected response stream', async () => {
    const held = latch()
    const onClose = vi.fn()
    const cancel = vi.fn()
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        ctx.server.waitUntil!(held.promise)
        return new ReadableStream<Uint8Array>({ cancel })
      }),
      a => a.shutdown(s => s.drainDelay(0)).hook('onClose', onClose),
    )
    const controller = new AbortController()
    const reason = new Error('caller disconnected')

    try {
      const response = await served.request('/s', { signal: controller.signal })
      expect(response.status).toBe(200)
      controller.abort(reason)
      await expect(response.text()).rejects.toBe(reason)
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)

      const closing = served.close()
      await tick()
      expect(onClose).not.toHaveBeenCalled()
      held.release()
      await closing
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      controller.abort(reason)
      held.release()
    }
  })

  it('cuts unread injected responses on successive drain sweeps while waiting for background work', async () => {
    const held = latch()
    const cancelAdmitted = vi.fn()
    const cancelClosing = vi.fn()
    const onClose = vi.fn()
    const closingCapability = vi.fn()
    @Catch(ErrHTTPServiceUnavailable)
    class StreamClosingResponse implements ErrorHandler<ErrHTTPServiceUnavailable> {
      handle(ctx: IContext): void {
        closingCapability('waitUntil' in ctx.server)
        ctx.status(503).body(new ReadableStream<Uint8Array>({ cancel: cancelClosing }))
      }
    }
    const served = await serve(
      new Router('/s').get('/').handler(ctx => {
        ctx.server.waitUntil!(held.promise)
        return new ReadableStream<Uint8Array>({ cancel: cancelAdmitted })
      }),
      a =>
        a
          .errorHandling(e => e.globalHandlers(StreamClosingResponse))
          .shutdown(s => s.drainDelay(0).shutdownTimeout(0))
          .hook('onClose', onClose),
    )

    let admitted: Response | undefined
    let refused: Response | undefined
    try {
      admitted = await served.request('/s')
      expect(admitted.status).toBe(200)
      const closing = served.close()
      await tick()
      expect(cancelAdmitted).toHaveBeenCalledTimes(1)
      await expect(admitted.text()).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)

      refused = await served.request('/s')
      expect(refused.status).toBe(503)
      expect(closingCapability).toHaveBeenCalledExactlyOnceWith(false)
      await expect(refused.text()).rejects.toBeInstanceOf(ErrHTTPServiceUnavailable)
      await vi.waitFor(() => expect(cancelClosing).toHaveBeenCalledTimes(1))
      expect(cancelAdmitted).toHaveBeenCalledTimes(1)
      expect(onClose).not.toHaveBeenCalled()

      held.release()
      await closing
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      held.release()
      await admitted?.body?.cancel().catch(() => undefined)
      await refused?.body?.cancel().catch(() => undefined)
    }
  })

  it('refuses work registered by a handler after its route timeout', async () => {
    const resume = latch()
    const attempted = latch()
    let refusal: unknown
    const served = await serve(
      new Router('/s')
        .get('/')
        .timeout(50 * Millisecond)
        .handler(async ctx => {
          const waitUntil = ctx.server.waitUntil!
          await resume.promise
          try {
            waitUntil(Promise.resolve())
          } catch (err) {
            refusal = err
          }
          attempted.release()
          return 'late'
        }),
      a => a.logger(b => b.use(newNoopLogger())),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const pending = served.request('/s')
      await vi.advanceTimersByTimeAsync(50)
      expect((await pending).status).toBe(503)
      resume.release()
      await attempted.promise
      expect(refusal).toMatchObject({ code: 'ERR_WAIT_UNTIL_CLOSED' })
    } finally {
      resume.release()
    }
  })

  it('forces shutdown at its deadline and observes work that rejects after close', async () => {
    const registered = Promise.withResolvers<void>()
    const refused = Promise.withResolvers<void>()
    const failure = new Error('registered work failed')
    const lateFailure = new Error('refused work failed')
    const logger = capturing()
    const onClose = vi.fn()
    const admitted = latch()
    const resume = latch()
    const attempted = latch()
    let reqId: string | undefined
    let refusal: unknown
    const served = await serve(
      new Router('/s').get('/').handler(async ctx => {
        reqId = ctx.req.id
        const waitUntil = ctx.server.waitUntil!
        admitted.release()
        waitUntil(registered.promise)
        await resume.promise
        try {
          waitUntil(refused.promise)
        } catch (err) {
          refusal = err
        }
        attempted.release()
        return 'late'
      }),
      a =>
        a
          .logger(b => b.use(logger))
          .shutdown(s => s.drainDelay(0).shutdownTimeout(200 * Millisecond))
          .hook('onClose', onClose),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const pending = served.request('/s').catch((err: unknown) => err)
      await admitted.promise
      const closing = served.close().catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(199)
      expect(onClose).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      const error = await closing
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
      expect(await pending).toBeInstanceOf(ErrHTTPServiceUnavailable)
      expect(onClose).toHaveBeenCalledTimes(1)

      resume.release()
      await attempted.promise
      expect(refusal).toMatchObject({ code: 'ERR_WAIT_UNTIL_CLOSED' })
      registered.reject(failure)
      refused.reject(lateFailure)
      await tick()
      expect(logger.error.mock.calls.filter(([, message]) => message === 'Background work failed')).toEqual([
        [{ reqId, err: failure }, 'Background work failed'],
        [{ reqId, err: lateFailure }, 'Background work failed'],
      ])
    } finally {
      resume.release()
      registered.resolve()
      refused.resolve()
      await vi.runOnlyPendingTimersAsync()
    }
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
