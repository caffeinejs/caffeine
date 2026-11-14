import { Injectable } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ActionResult,
  Catch,
  type ErrorHandler,
  type Guard,
  HTTPPlugin,
  type HTTPSetupContext,
  type IContext,
  type RouteDefinition,
  Router,
} from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

// The lifecycle as every application runs it: this file is in the Fastify, fetch and Node projects alike.

const trace: string[] = []

@Injectable()
class TracingGuard implements Guard {
  guard(): boolean {
    trace.push('guard')
    return true
  }
}

@Catch(Error)
class RecordingHandler implements ErrorHandler<Error> {
  handle(ctx: IContext, error: Error): ActionResult {
    trace.push(`handler:${error.message}`)
    return ctx.status(418).body({ handled: error.message })
  }
}

/** An `HTTPPlugin` whose `register` is `fn`. */
function plugin(fn: (context: HTTPSetupContext) => void): () => HTTPPlugin {
  return () =>
    new (class extends HTTPPlugin {
      register(context: HTTPSetupContext): void {
        fn(context)
      }
    })()
}

type App = ReturnType<typeof createWebApplication>
let app: App | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  trace.length = 0
})

async function boot(build: (app: App) => unknown): Promise<App> {
  app = createWebApplication()
  build(app)
  await app.bootstrap()
  return app
}

describe('lifecycle hooks', () => {
  // The program's fixed order: the application's own hooks, then a router plugin's, then the guards, then the router's,
  // then the route's, then what onRoute added.
  it('runs onRequest hooks in the fixed order', async () => {
    const pets = new Router('/pets')
      .with(plugin(({ app: ops }) => ops.hook('onRequest', () => void trace.push('router plugin'))))
      .guards([TracingGuard])
      .hook('onRequest', () => void trace.push('router'))
      .get('/')
      .hook('onRequest', () => void trace.push('route'))
      .handler(() => 'ok')

    const a = await boot(a =>
      a
        .hook('onRequest', () => void trace.push('app'))
        .with(
          plugin(({ app: ops }) =>
            ops.hook('onRoute', route => route.hook('onRequest', () => void trace.push('onRoute'))),
          ),
        )
        .mount(pets),
    )

    const res = await a.request('/pets')

    expect(await res.text()).toBe('ok')
    expect(trace).toEqual(['app', 'router plugin', 'guard', 'router', 'route', 'onRoute'])
  })

  it('runs a middleware at preHandler after every onRequest hook', async () => {
    const a = await boot(a =>
      a
        .use(
          (_ctx, next) => {
            trace.push('middleware')
            next()
          },
          { hook: 'preHandler' },
        )
        .hook('onRequest', () => void trace.push('onRequest'))
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    await a.request('/x')

    expect(trace).toEqual(['onRequest', 'middleware'])
  })

  // What a CORS or cache header needs: the answer is shaped, and the head can still change.
  it('lets onSend set a header that goes out', async () => {
    const a = await boot(a =>
      a
        .hook('onSend', ctx => {
          ctx.header('x-sent', 'yes')
        })
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    const res = await a.request('/x')

    expect(res.headers.get('x-sent')).toBe('yes')
    expect(await res.text()).toBe('x')
  })

  it('lets onSend replace the payload, and the length follows it', async () => {
    const a = await boot(a =>
      a
        .hook('onSend', (_ctx, payload) => (typeof payload === 'string' ? payload.toUpperCase() + '!' : payload))
        .mount(new Router('/x').get('/').handler(() => 'hello')),
    )

    const res = await a.request('/x')

    expect(await res.text()).toBe('HELLO!')
    expect(res.headers.get('content-length')).toBe('6')
  })

  it('sends no body when onSend returns null', async () => {
    const a = await boot(a => a.hook('onSend', () => null).mount(new Router('/x').get('/').handler(() => 'hello')))

    const res = await a.request('/x')

    expect(await res.text()).toBe('')
  })

  // A cached answer served from onRequest still passes the cache's own onSend.
  it('skips the handler after an onRequest hook answered, and still runs onSend', async () => {
    const a = await boot(a =>
      a
        .hook('onRequest', ctx => {
          ctx.body('cached')
        })
        .hook('onSend', () => void trace.push('onSend'))
        .mount(
          new Router('/x').get('/').handler(() => {
            trace.push('handler')
            return 'fresh'
          }),
        ),
    )

    const res = await a.request('/x')

    expect(await res.text()).toBe('cached')
    expect(trace).toEqual(['onSend'])
  })

  it('runs onError before the error handler, which still answers', async () => {
    const a = await boot(a =>
      a
        .errorHandling(e => e.globalHandlers(RecordingHandler))
        .hook('onError', (_ctx, err) => void trace.push(`onError:${err.message}`))
        .mount(
          new Router('/x').get('/').handler(() => {
            throw new Error('boom')
          }),
        ),
    )

    const res = await a.request('/x')

    expect(res.status).toBe(418)
    expect(trace).toEqual(['onError:boom', 'handler:boom'])
  })

  // An observer that fails must not replace the application's own answer to the error.
  it('leaves the error handler answer when an onError hook throws', async () => {
    const a = await boot(a =>
      a
        .errorHandling(e => e.globalHandlers(RecordingHandler))
        .hook('onError', () => {
          throw new Error('observer')
        })
        .mount(
          new Router('/x').get('/').handler(() => {
            throw new Error('boom')
          }),
        ),
    )

    const res = await a.request('/x')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ handled: 'boom' })
  })

  it('answers 500 after onError ran when an onSend hook throws', async () => {
    const a = await boot(a =>
      a
        .hook('onError', (_ctx, err) => void trace.push(`onError:${err.message}`))
        .hook('onSend', () => {
          throw new Error('send')
        })
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    const res = await a.request('/x')

    expect(res.status).toBe(500)
    expect(((await res.json()) as { code: string }).code).toBe('ERR_INTERNAL')
    expect(trace).toEqual(['onError:send'])
  })

  // The 500 is a problem of its own: what described the answer it replaces must not describe it.
  it('drops the representation headers of the answer a failed onSend replaced', async () => {
    const a = await boot(a =>
      a
        .hook('onSend', ctx => {
          ctx.header('content-encoding', 'gzip').header('content-disposition', 'attachment').header('etag', '"v1"')
          throw new Error('send')
        })
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    const res = await a.request('/x')

    expect(res.status).toBe(500)
    expect([
      res.headers.get('content-encoding'),
      res.headers.get('content-disposition'),
      res.headers.get('etag'),
    ]).toEqual([null, null, null])
  })

  it('skips every later onSend hook once one threw', async () => {
    const a = await boot(a =>
      a
        .with(
          plugin(({ app: ops }) =>
            ops.hook('onSend', () => {
              throw new Error('send')
            }),
          ),
        )
        .with(plugin(({ app: ops }) => ops.hook('onSend', ctx => void ctx.header('x-later', 'ran'))))
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    const res = await a.request('/x')

    expect(res.status).toBe(500)
    expect(res.headers.get('x-later')).toBe(null)
  })

  it('skips a middleware at onSend once an onSend hook threw', async () => {
    const a = await boot(a =>
      a
        .hook('onSend', () => {
          throw new Error('send')
        })
        .use(
          (ctx, next) => {
            ctx.header('x-middleware', 'ran')
            next()
          },
          { hook: 'onSend' },
        )
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    const res = await a.request('/x')

    expect(res.status).toBe(500)
    expect(res.headers.get('x-middleware')).toBe(null)
  })

  it('runs onResponse once the answer has left, the next one even after one threw', async () => {
    let answered!: () => void
    const done = new Promise<void>(resolve => (answered = resolve))

    const a = await boot(a =>
      a
        .with(
          plugin(({ app: ops }) =>
            ops.hook('onResponse', () => {
              throw new Error('observer')
            }),
          ),
        )
        .with(
          plugin(({ app: ops }) =>
            ops.hook('onResponse', ctx => {
              trace.push(`onResponse:${ctx.statusCode}`)
              answered()
            }),
          ),
        )
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )

    const res = await a.request('/x')
    await res.text()
    await done

    expect(trace).toEqual(['onResponse:200'])
  })

  it('runs onReady before the first request', async () => {
    const a = await boot(a =>
      a
        .hook('onReady', () => void trace.push('ready'))
        .mount(
          new Router('/x').get('/').handler(() => {
            trace.push('request')
            return 'x'
          }),
        ),
    )

    expect(trace).toEqual(['ready'])
    await a.request('/x')
    expect(trace).toEqual(['ready', 'request'])
  })

  it('hands a hook the route the request matched, and none on a miss', async () => {
    const seen: Array<RouteDefinition | undefined> = []

    const a = await boot(a =>
      a
        .hook('onRequest', ctx => void seen.push(ctx.route))
        .mount(
          new Router('/pets')
            .get('/:id')
            .config('flag', 'on')
            .handler(() => 'pet'),
        ),
    )

    await a.request('/pets/1')
    await a.request('/nowhere')

    expect(seen).toHaveLength(2)
    expect(seen[0]?.url).toBe('/pets/:id')
    expect(seen[0]?.methods).toEqual(['GET'])
    expect(seen[0]?.config.get('flag')).toBe('on')
    expect(seen[1]).toBe(undefined)
  })
})
