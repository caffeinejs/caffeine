import { Injectable } from '@caffeinejs/di'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ActionResult,
  Catch,
  type Context,
  ErrHTTPBadRequest,
  type ErrorHandler,
  type Guard,
  type GuardInput,
  Guards,
  Ops,
  RouteBuilder,
  bindTo,
  createWebApplication,
  newRouter,
  type WebApplication,
} from '../../index.js'

/**
 * Scenario: ops routers with middleware, guards and plugins.
 *
 * What a router asks for itself — `router.plugin(...)` and `router.guards(...)`, the counterparts of `@Use(...)` and
 * `@UseGuards(...)` — follows the router to whichever server serves it, nested routers included. What a server
 * registers for itself is `plugins.test.ts`'s.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** A plugin marking every response it covers with `header`. */
function marking(header: string, value = 'yes') {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.addHook('onRequest', (_request, reply, done) => {
          const previous = reply.getHeader(header)
          reply.header(header, previous === undefined ? value : `${String(previous)},${value}`)
          done()
        })
      },
      { name: `marking:${header}:${value}` },
    )
}

@Injectable()
class DenyGuard implements Guard {
  guard(): boolean {
    return false
  }
}

@Injectable()
class TokenGuard implements Guard {
  guard(input: GuardInput): boolean {
    return input.context.req.header('x-token') === 'ok'
  }
}

class Teapot extends Error {}

@Catch(Teapot)
class TeapotHandler implements ErrorHandler<Teapot> {
  handle(ctx: Context): ActionResult {
    return ctx.status(418).body({ teapot: true })
  }
}

void [DenyGuard, TokenGuard, TeapotHandler]

describe('ops routers with middleware, guards and plugins', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  const ops = () => Ops('admin', o => o.server(() => ({ listener })))

  function at(server: 'main' | 'admin', path: string, headers?: Record<string, string>): Promise<Response> {
    const origin = server === 'main' ? app!.address!.origin : app!.ops.get('admin')!.address!.origin
    return fetch(`${origin}${path}`, { headers })
  }

  it("runs a router's own plugin on what it serves on the ops server, and nowhere else", async () => {
    app = createWebApplication()
      .install(ops())
      .server(() => ({ listener }))
      .mount(
        newRouter('/jobs')
          .with(bindTo('admin'))
          .plugin(marking('x-router-plugin'))
          .get('/', () => ({ jobs: true })),
        newRouter('/api').get('/', () => ({ api: true })),
      ) as WebApplication

    await app.run()

    expect((await at('admin', '/jobs')).headers.get('x-router-plugin')).toBe('yes')
    expect((await at('main', '/api')).headers.get('x-router-plugin')).toBeNull()
  })

  it("denies with the router's own guards on the ops server, and runs the global guards there too", async () => {
    app = createWebApplication()
      .install(ops())
      .install(Guards(g => g.global(TokenGuard)))
      .mount(
        newRouter('/denied')
          .with(bindTo('admin'))
          .guards([DenyGuard])
          .get('/', () => ({ denied: false })),
        newRouter('/open')
          .with(bindTo('admin'))
          .get('/', () => ({ open: true })),
      ) as WebApplication

    await app.run()

    expect((await at('admin', '/denied', { 'x-token': 'ok' })).status).toBe(403)
    expect((await at('admin', '/open')).status).toBe(403)
    expect((await at('admin', '/open', { 'x-token': 'ok' })).status).toBe(200)
  })

  it('carries the binding, the plugin and the guards of a router down to the routers nested in it', async () => {
    app = createWebApplication()
      .install(ops())
      .server(() => ({ listener }))
      .mount(
        newRouter('/ops')
          .with(bindTo('admin'))
          .plugin(marking('x-parent-plugin'))
          .guards([TokenGuard])
          .group('/child', child => child.get('/', () => ({ child: true }))),
      ) as WebApplication

    await app.run()

    expect((await at('admin', '/ops/child')).status).toBe(403)

    const allowed = await at('admin', '/ops/child', { 'x-token': 'ok' })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('x-parent-plugin')).toBe('yes')

    expect((await at('main', '/ops/child', { 'x-token': 'ok' })).status).toBe(404)
  })

  describe('$route', () => {
    const extra = (bind?: string) => (instance: FastifyInstance) => {
      instance.$route('extra', group => {
        if (bind !== undefined) {
          bindTo(bind)(group)
        }

        group.path('/extra').routes([
          new RouteBuilder()
            .method('GET')
            .path('/')
            .handle(() => ({ extra: true })),
        ])
      })
    }

    it('adds the group to the ops server whose plugin calls it', async () => {
      app = createWebApplication()
        .install(
          Ops('admin', o =>
            o.server(() => ({ listener })).with(() => async (instance: FastifyInstance) => extra()(instance)),
          ),
        )
        .server(() => ({ listener })) as WebApplication

      await app.run()

      expect(await (await at('admin', '/extra')).json()).toEqual({ extra: true })
      expect((await at('main', '/extra')).status).toBe(404)
    })

    it("refuses a group bound to an ops server from the application's own server", async () => {
      app = createWebApplication()
        .install(ops())
        .with(() => async (instance: FastifyInstance) => extra('admin')(instance)) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(
        /^Cannot add route group "extra" to the application's own server: it is bound to "admin"/,
      )
    })

    it('refuses a group bound to another server from an ops server', async () => {
      app = createWebApplication().install(
        Ops('admin', o =>
          o.server(() => ({ listener })).with(() => async (instance: FastifyInstance) => extra('metrics')(instance)),
        ),
      ) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(
        /^Cannot add route group "extra" to ops server "admin": it is bound to "metrics"/,
      )
    })
  })

  it("answers on the ops server with the application's error handlers and its not-found envelope", async () => {
    app = createWebApplication()
      .install(ops())
      .server(() => ({ listener }))
      .errorHandling(e => e.globalHandlers(TeapotHandler))
      .mount(
        newRouter('/failing')
          .with(bindTo('admin'))
          .get('/teapot', () => {
            throw new Teapot()
          })
          .get('/bad', () => {
            throw new ErrHTTPBadRequest('bad input')
          }),
        newRouter('/failing-main').get('/bad', () => {
          throw new ErrHTTPBadRequest('bad input')
        }),
      ) as WebApplication

    await app.run()

    const teapot = await at('admin', '/failing/teapot')
    expect(teapot.status).toBe(418)
    expect(await teapot.json()).toEqual({ teapot: true })

    const bad = await at('admin', '/failing/bad')
    const badOnMain = await at('main', '/failing-main/bad')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual(await badOnMain.json())

    const missing = await at('admin', '/nothing-here')
    const missingOnMain = await at('main', '/nothing-here')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual(await missingOnMain.json())
  })
})
