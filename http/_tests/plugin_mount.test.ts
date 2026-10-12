import { CaffeineIoC, Injectable } from '@caffeinejs/di'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ErrAuthenticationRequired,
  Ops,
  Router,
  createWebApplication,
  newRouter,
  type Guard,
  type HTTPSetupContext,
  type RouteGroup,
  type WebApplication,
} from '../index.js'

/**
 * A router a plugin factory mounts through its context: `context.app.mount(...)` is the application's own `mount`,
 * reached from inside start-up. Where an ops server's factory mounts is `ops/_tests/routers.test.ts`'s.
 */

/** A plugin marking every response it covers with `header`. */
function marking(header: string) {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header(header, 'yes')
          done()
        })
      },
      { name: `marking:${header}` },
    )
}

@Injectable()
class Greeter {
  greet(): string {
    return 'hello'
  }
}

@Injectable()
class DenyGuard implements Guard {
  guard(): boolean {
    return false
  }
}

let guardConstructions = 0

@Injectable()
class CountingGuard implements Guard {
  constructor() {
    guardConstructions++
  }

  guard(): boolean {
    return true
  }
}

void [Greeter, DenyGuard, CountingGuard]

describe('a router a plugin factory mounts', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it('is served like a router the application mounts, from a factory that installs nothing else', async () => {
    app = createWebApplication({ container: new CaffeineIoC() }).with(({ app: application }) =>
      application.mount(
        new Router('/jobs')
          .inject({ greeter: Greeter })
          .get('/:id', (ctx, deps) => ({ id: ctx.req.param().id, greeting: deps.greeter.greet() }))
          .group('/:id/runs', runs => runs.get('/', () => ['first'])),
      ),
    )
    await app.bootstrap()

    expect(await (await app.fetch('/jobs/7')).json()).toEqual({ id: '7', greeting: 'hello' })
    expect(await (await app.fetch('/jobs/7/runs')).json()).toEqual(['first'])
    expect(app.routeGroups.map(group => [group.name, group.routes.map(route => route.name)])).toEqual([
      ['Jobs', ['get_id']],
      ['JobsIdRuns', ['get_index']],
    ])
  })

  // Each server is routed once its plugins have loaded, the application's own first, so a factory and the plugin it
  // returns see the servers routed before theirs, and the array they kept fills in as the others are.
  it('fills the route table server by server, in the very array a factory kept', async () => {
    let kept: readonly RouteGroup<unknown>[] | undefined
    let ownFactory: string[] | undefined
    let ownPlugin: string[] | undefined
    let opsFactory: string[] | undefined

    app = createWebApplication()
      .install(
        Ops('admin', o =>
          o.with(context => {
            opsFactory = context.routeGroups.map(group => group.path)
            return context.app.mount(new Router('/ops-mounted').get('/', () => 'ops'))
          }),
        ),
      )
      .with(context => {
        kept = context.routeGroups
        ownFactory = context.routeGroups.map(group => group.path)

        return fp(
          async () => {
            ownPlugin = context.routeGroups.map(group => group.path)
          },
          { name: 'route-table-probe' },
        )
      })
      .with(({ app: application }) => application.mount(new Router('/mounted').get('/', () => 'own')))
      .mount(newRouter('/declared').get('/', () => 'declared')) as WebApplication

    await app.bootstrap()

    expect(ownFactory).toEqual([])
    expect(ownPlugin).toEqual([])
    expect(opsFactory?.toSorted()).toEqual(['/declared', '/mounted'])
    expect(app.routeGroups.map(group => group.path).toSorted()).toEqual(['/declared', '/mounted', '/ops-mounted'])
    expect(kept).toBe(app.routeGroups)
  })

  // A plugin loads before its server is routed, so the plugin a factory returns mounts like the factory itself,
  // whichever style it is written in. avvio does not catch a callback-style plugin's throw, so refusing it here would
  // end the process.
  it.each(['async', 'callback-style'])('serves what the %s plugin a factory returned mounts', async style => {
    const late = () => new Router('/late').get('/', () => ({ style }))

    app = createWebApplication().with(context =>
      style === 'async'
        ? fp(
            async () => {
              context.app.mount(late())
            },
            { name: 'late-mount' },
          )
        : fp(
            (_instance, _options, done) => {
              context.app.mount(late())
              done()
            },
            { name: 'late-mount' },
          ),
    )
    await app.bootstrap()

    expect(await (await app.fetch('/late')).json()).toEqual({ style })
  })

  it('installs its own plugins in front of its routes, and nowhere else', async () => {
    app = createWebApplication()
      .with(({ app: application }) =>
        application.mount(
          newRouter('/scoped')
            .plugin(marking('x-scoped'))
            .get('/', () => 'scoped'),
        ),
      )
      .mount(newRouter('/plain').get('/', () => 'plain')) as WebApplication
    await app.bootstrap()

    expect((await app.fetch('/scoped')).headers.get('x-scoped')).toBe('yes')
    expect((await app.fetch('/plain')).headers.get('x-scoped')).toBeNull()
  })

  it('answers to its guards like any other route', async () => {
    app = createWebApplication({ container: new CaffeineIoC() }).with(({ app: application }) =>
      application.mount(new Router('/closed').guards([DenyGuard]).get('/', () => 'never')),
    )
    await app.bootstrap()

    expect((await app.fetch('/closed')).status).toBe(403)
  })

  it('takes part in the start-up checks: a protected route with no authentication refuses to start', async () => {
    app = createWebApplication().with(({ app: application }) =>
      application.mount(new Router('/secret').authorize().get('/', () => 'secret')),
    )

    await expect(app.bootstrap()).rejects.toThrow(ErrAuthenticationRequired)
  })

  // Compiled with every other router, so a guard both declare resolves through one cache and is built once.
  it('shares one guard instance with a router the application mounts', async () => {
    guardConstructions = 0

    app = createWebApplication({ container: new CaffeineIoC() })
      .with(({ app: application }) =>
        application.mount(new Router('/mounted').guards([CountingGuard]).get('/', () => 'ok')),
      )
      .mount(new Router('/ordinary').guards([CountingGuard]).get('/', () => 'ok')) as WebApplication
    await app.bootstrap()

    expect(guardConstructions).toBe(1)
  })

  // Typed code cannot write one. Untyped code would otherwise drop a forgotten plugin without a word, and Fastify's
  // own refusal would come later, once the server was half built.
  it('refuses a factory that returns nothing, before its server is built', async () => {
    let customized = false

    app = createWebApplication()
      .serverCallback(() => {
        customized = true
      })
      .with(((context: HTTPSetupContext) => {
        context.app.mount(new Router('/forgotten').get('/', () => 'forgotten'))
      }) as never)

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_CONFIGURATION',
      message: expect.stringMatching(
        /^Cannot register the plugin of "\.with\(\.\.\.\)" #1 on the application's own server: its factory returned nothing/,
      ),
    })
    expect(customized).toBe(false)
  })

  describe('once its server is routed', () => {
    const refusal = /^Cannot mount a router on the application's own server: its routing has already been built/

    // An `onReady` hook runs once the server's routes have registered: nothing would serve the router.
    it('refuses a mount from a hook, failing the start', async () => {
      app = createWebApplication().with(context =>
        fp(
          async (instance: FastifyInstance) => {
            instance.addHook('onReady', async () => {
              context.app.mount(new Router('/hooked').get('/', () => 'hooked'))
            })
          },
          { name: 'hook-mount' },
        ),
      )

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CONFIGURATION',
        message: expect.stringMatching(refusal),
      })
    })

    it("refuses a mount from a router's plugin factory, failing the start", async () => {
      app = createWebApplication().mount(
        newRouter('/owner')
          .plugin(context => {
            context.app.mount(new Router('/sneaked').get('/', () => 'sneaked'))
            return fp(async () => undefined, { name: 'owner-plugin' })
          })
          .get('/', () => 'owner'),
      ) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CONFIGURATION',
        message: expect.stringMatching(refusal),
      })
    })

    it('refuses a mount once the application has started, at once', async () => {
      let kept: HTTPSetupContext | undefined

      app = createWebApplication().with(context => {
        kept = context
        return context.app.mount(new Router('/first').get('/', () => 'first'))
      })
      await app.bootstrap()

      expect(() => kept!.app.mount(new Router('/after').get('/', () => 'after'))).toThrow(refusal)
    })
  })
})
