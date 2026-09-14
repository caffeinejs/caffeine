import { CaffeineIoC, Injectable } from '@caffeinejs/di'
import fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ErrAuthenticationRequired,
  Guard,
  Router,
  RouteBuilder,
  RouteGroupBuilder,
  createWebApplication,
  fastifyAdapterFactory,
  type GuardInput,
  type HTTPPluginFactory,
  type WebApplication,
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
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(
        lateRoute(router => {
          router.path('/late').routes([
            new RouteBuilder()
              .method('GET')
              .path('/hello')
              .handle(() => ({ ok: true })),
          ])
        }),
      )
      .build()
    await app.ready()

    const res = await app.fetch('/late/hello')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('does not appear in $routeGroups', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(
        lateRoute(router => {
          router.path('/late').routes([
            new RouteBuilder()
              .method('GET')
              .path('/hidden')
              .handle(() => ({})),
          ])
        }),
      )
      .build()
    await app.ready()

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
    container.bind(DenyGuard, t => t.toSelf())

    app = createWebApplication(fastifyAdapterFactory(fastify()), { container })
      .with(
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
      .build()
    await app.ready()

    const res = await app.fetch('/late/closed')
    expect(res.status).toBe(403)
  })

  it('participates in the startup check for a protected route with no authentication configured', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(
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
      .build()

    await expect(app.ready()).rejects.toThrow(ErrAuthenticationRequired)
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
    container.bind(CountingGuard, t => t.toSelf())

    const ordinary = new Router('/ordinary').guards([CountingGuard])
    ordinary.get('/hello').handler(() => ({ ok: true }))

    app = createWebApplication(fastifyAdapterFactory(fastify()), { container })
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
      .build()
      .mount(ordinary) as WebApplication
    await app.ready()

    expect(constructions).toBe(1)
  })
})
