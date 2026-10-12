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
  type HTTPSetupContext,
  Ops,
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

  describe("a router an ops server's plugin factory mounts", () => {
    // What keeps an ops server's routes, DevTools' among them, off the application's public port.
    it("is served on that ops server, bound to it, and not on the application's own", async () => {
      app = createWebApplication()
        .install(
          Ops('admin', o =>
            o
              .server(() => ({ listener }))
              .with(({ app: application }) => application.mount(newRouter('/mounted').get('/', () => ({ ok: true })))),
          ),
        )
        .server(() => ({ listener })) as WebApplication

      await app.run()

      expect(await (await at('admin', '/mounted')).json()).toEqual({ ok: true })
      expect((await at('main', '/mounted')).status).toBe(404)
      expect(app.routeGroups.find(group => group.path === '/mounted')?.boundTo).toBe('admin')
    })

    // An ops server's factories mount on that server alone: the servers before it are built by the time they run.
    it('refuses a router bound to another server', async () => {
      app = createWebApplication()
        .install(
          Ops('admin', o =>
            o.with(({ app: application }) =>
              application.mount(
                newRouter('/elsewhere')
                  .with(bindTo('metrics'))
                  .get('/', () => ({ ok: true })),
              ),
            ),
          ),
        )
        .install(Ops('metrics')) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CONFIGURATION',
        message: expect.stringMatching(
          /^Cannot mount router "Elsewhere" on ops server "admin": it is bound to "metrics"/,
        ),
      })
    })

    // The application's own server is routed first, so its factories mount for any server, as `app.mount(...)` does.
    it("serves on it a router the application's own factory binds to it, and not on the application's own", async () => {
      app = createWebApplication()
        .install(Ops('admin'))
        .with(({ app: application }) =>
          application.mount(
            newRouter('/bound')
              .with(bindTo('admin'))
              .get('/', () => ({ ok: true })),
          ),
        ) as WebApplication

      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/bound')).status).toBe(200)
      expect((await app.fetch('/bound')).status).toBe(404)
    })

    // Two copies would register the same paths twice, which the server refuses.
    it('serves once a router the application mounts and its factory mounts again', async () => {
      const twice = newRouter('/twice')
        .with(bindTo('admin'))
        .get('/', () => ({ ok: true }))

      app = createWebApplication()
        .install(Ops('admin', o => o.with(({ app: application }) => application.mount(twice))))
        .mount(twice) as WebApplication

      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/twice')).status).toBe(200)
    })

    it('serves once a router two of its factories mount', async () => {
      const twice = newRouter('/twice').get('/', () => ({ ok: true }))
      const mountTwice = ({ app: application }: HTTPSetupContext) => application.mount(twice)

      app = createWebApplication().install(Ops('admin', o => o.with(mountTwice).with(mountTwice))) as WebApplication

      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/twice')).status).toBe(200)
    })

    // avvio does not catch a callback-style plugin's throw, so a plugin that loads before its server is routed mounts
    // there rather than being refused.
    it('serves what the callback-style plugin its factory returned mounts', async () => {
      app = createWebApplication().install(
        Ops('admin', o =>
          o.with(context =>
            fp(
              (_instance, _options, done) => {
                context.app.mount(newRouter('/late').get('/', () => ({ ok: true })))
                done()
              },
              { name: 'ops-late-mount' },
            ),
          ),
        ),
      ) as WebApplication

      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/late')).status).toBe(200)
    })

    // Bound by nesting it, not by labelling it, so neither server takes the router from the other. Its plugins are a
    // router's own, resolved once and installed wherever its routes are served.
    it("serves one router two ops servers' factories mount on both, resolving its plugins once", async () => {
      let resolved = 0
      const shared = newRouter('/shared')
        .plugin(() => {
          resolved++
          return marking('x-shared')()
        })
        .get('/', () => ({ ok: true }))
      const mountShared = ({ app: application }: HTTPSetupContext) => application.mount(shared)

      app = createWebApplication()
        .install(Ops('admin', o => o.with(mountShared)))
        .install(Ops('metrics', o => o.with(mountShared))) as WebApplication

      await app.bootstrap()

      for (const name of ['admin', 'metrics']) {
        const res = await app.ops.get(name)!.fetch('/shared')
        expect(res.status).toBe(200)
        expect(res.headers.get('x-shared')).toBe('yes')
      }
      expect(resolved).toBe(1)
    })
  })
})
