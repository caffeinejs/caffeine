import { CaffeineIoC, Injectable } from '@caffeinejs/di'
import { type FastifyInstance, type FastifyPluginCallback } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ErrAuthenticationRequired,
  Guard,
  Router,
  RouteBuilder,
  RouteGroupBuilder,
  createWebApplication,
  newRouter,
  type GuardInput,
  type HTTPPluginFactory,
  type WebApplication,
  Guards,
} from '../index.js'

/** A plugin registered through `.with(...)`, so it runs at the exact point `$route` is meant to be called from. */
function lateRoute(build: (router: RouteGroupBuilder) => void): HTTPPluginFactory {
  return () => async (instance: FastifyInstance) => {
    instance.$route('late', build)
  }
}

describe('$route', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('registers a route that responds, through a plugin registered with .with(...)', async () => {
    app = createWebApplication().with(
      lateRoute(router => {
        router.path('/late').routes([
          new RouteBuilder()
            .method('GET')
            .path('/hello')
            .handle(() => ({ ok: true })),
        ])
      }),
    )
    await app.bootstrap()

    const res = await app.fetch('/late/hello')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('does not appear in app.routeGroups', async () => {
    app = createWebApplication().with(
      lateRoute(router => {
        router.path('/late').routes([
          new RouteBuilder()
            .method('GET')
            .path('/hidden')
            .handle(() => ({})),
        ])
      }),
    )
    await app.bootstrap()

    expect(app.routeGroups.some(g => g.path === '/late')).toBe(false)
  })

  it('enforces a guard attached to the group', async () => {
    @Injectable()
    class DenyGuard implements Guard {
      guard(_input: GuardInput): boolean {
        return false
      }
    }

    const container = new CaffeineIoC()

    app = createWebApplication({ container }).with(
      lateRoute(router => {
        router
          .path('/late')
          .guards([DenyGuard])
          .routes([
            new RouteBuilder()
              .method('GET')
              .path('/closed')
              .handle(() => ({ ok: true })),
          ])
      }),
    )
    await app.bootstrap()

    const res = await app.fetch('/late/closed')
    expect(res.status).toBe(403)
  })

  it('participates in the startup check for a protected route with no authentication configured', async () => {
    app = createWebApplication().with(
      lateRoute(router => {
        router
          .path('/late')
          .authorize({})
          .routes([
            new RouteBuilder()
              .method('GET')
              .path('/secret')
              .handle(() => ({ ok: true })),
          ])
      }),
    )

    await expect(app.bootstrap()).rejects.toThrow(ErrAuthenticationRequired)
    app = undefined
  })

  // Regression guard for the bug the compiler-sharing fix closed: a guard used by both an ordinary route and
  // a `$route` one must resolve through the one compiler `buildRouting()` built, not a second one — otherwise
  // a singleton guard with no request-scoped dependencies gets constructed twice.
  it('shares one guard instance with an ordinary route, through the same compiler buildRouting() built', async () => {
    let constructions = 0

    @Injectable()
    class CountingGuard implements Guard {
      constructor() {
        constructions++
      }

      guard(): boolean {
        return true
      }
    }

    const container = new CaffeineIoC()

    const ordinary = new Router('/ordinary').guards([CountingGuard])
    ordinary.get('/hello').handler(() => ({ ok: true }))

    app = createWebApplication({ container })
      .with(
        lateRoute(router => {
          router
            .path('/late')
            .guards([CountingGuard])
            .routes([
              new RouteBuilder()
                .method('GET')
                .path('/hello')
                .handle(() => ({ ok: true })),
            ])
        }),
      )
      .mount(ordinary) as WebApplication
    await app.bootstrap()

    expect(constructions).toBe(1)
  })

  describe('outside a .with(...) plugin', () => {
    const scoped = (router: RouteGroupBuilder) =>
      router.path('/scoped').routes([
        new RouteBuilder()
          .method('GET')
          .path('/x')
          .handle(() => ({ ok: true })),
      ])

    // A route group's plugin loads once the route table has closed: its group would miss the start-up checks and
    // the registration both, so the start is refused rather than the route quietly never being served.
    it('refuses a group added by a plugin a router registered', async () => {
      app = createWebApplication().mount(
        newRouter('/owner')
          .plugin(() => async (instance: FastifyInstance) => {
            instance.$route('scoped', scoped)
          })
          .get('/', () => ({})),
      ) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CONFIGURATION',
        message: expect.stringMatching(
          /^Cannot add route group "scoped": "\$route" is open only to a plugin registered with "\.with\(\.\.\.\)"/,
        ),
      })
      app = undefined
    })

    // Thrown on the spot, the refusal would escape a callback-style plugin as an uncaught exception.
    it('refuses it from a callback-style plugin as well, failing the start and not the process', async () => {
      const plugin: FastifyPluginCallback = (instance, _options, done) => {
        instance.$route('scoped', scoped)
        done()
      }

      app = createWebApplication().mount(
        newRouter('/owner-callback')
          .plugin(() => plugin)
          .get('/', () => ({})),
      ) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_CONFIGURATION' })
      app = undefined
    })

    it('throws at once when called after start-up', async () => {
      const running = createWebApplication()
      app = running
      await running.bootstrap()

      expect(() => running.instance.$route('scoped', scoped)).toThrow(/^Cannot add route group "scoped"/)
    })
  })
})
