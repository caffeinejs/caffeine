import { Injectable } from '@caffeinejs/di'
import { ErrFeatureNotInstalled } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type AdapterExtensionFactory,
  type Context,
  ErrAuthenticationRequired,
  type Guard,
  type GuardInput,
  Guards,
  HTTPPlugin,
  type HTTPSetupContext,
  Ops,
  Router,
  bindTo,
  createWebApplication,
  newRouter,
  type WebApplication,
} from '../index.js'

/**
 * Scenario: a plugin written against Caffeine alone. An `HTTPPlugin` installs in its `.with(...)` slot, and
 * `context.app.mount(...)` serves routers on the server that slot belongs to, through the same compilation a
 * mounted router gets. What a Fastify plugin does in that slot is `plugins.test.ts`'s.
 */

/** A plugin marking every response it covers with `header`. */
function marking(header: string, value = 'yes') {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header(header, value)
          done()
        })
      },
      { name: `marking:${header}` },
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

@Injectable()
class Greeter {
  greet(): string {
    return 'hello'
  }
}

void [DenyGuard, TokenGuard, Greeter]

/** The simplest plugin: one router, mounted from `install`. */
class Metrics extends HTTPPlugin {
  install({ app }: HTTPSetupContext): void {
    app.mount(newRouter('/metrics').get('/', () => ({ metrics: true })))
  }
}

/** Mounts a router bound to `server`, to see the binding refused. */
class Bound extends HTTPPlugin {
  readonly #server: string

  constructor(server: string) {
    super()
    this.#server = server
  }

  install({ app }: HTTPSetupContext): void {
    app.mount(
      newRouter('/metrics')
        .with(bindTo(this.#server))
        .get('/', () => ({ metrics: true })),
    )
  }
}

/** Keeps the context it was handed, to call `app.mount` once the slot has closed. */
class Keeper extends HTTPPlugin {
  context: HTTPSetupContext | undefined

  install(context: HTTPSetupContext): void {
    this.context = context
  }
}

describe('HTTPPlugin', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it("serves what install() mounted, on the application's own server", async () => {
    app = createWebApplication().with(() => new Metrics())
    await app.bootstrap()

    const res = await app.fetch('/metrics')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ metrics: true })
  })

  it('hands install() the setup context the factory got', async () => {
    let seen: HTTPSetupContext | undefined

    class Probe extends HTTPPlugin {
      install(context: HTTPSetupContext): void {
        seen = context
      }
    }

    app = createWebApplication().with(() => new Probe())
    await app.bootstrap()

    expect(seen?.container).toBe(app.container)
    expect(seen?.hasFeature('cookie')).toBe(true)
    expect(seen?.hasFeature('nothing')).toBe(false)
  })

  it('refuses the start when install() throws ErrFeatureNotInstalled, as a plugin factory does', async () => {
    class NeedsThing extends HTTPPlugin {
      install({ hasFeature }: HTTPSetupContext): void {
        if (!hasFeature('thing')) {
          throw new ErrFeatureNotInstalled('thing', 'Install it: ".install(Thing())"')
        }
      }
    }

    app = createWebApplication().with(() => new NeedsThing())

    await expect(app.bootstrap()).rejects.toThrow(ErrFeatureNotInstalled)
    app = undefined
  })

  it('installs in slot order, and before any Fastify plugin body runs', async () => {
    const order: string[] = []

    class Recording extends HTTPPlugin {
      readonly #name: string

      constructor(name: string) {
        super()
        this.#name = name
      }

      install(): void {
        order.push(this.#name)
      }
    }

    app = createWebApplication()
      .with(() => new Recording('a'))
      .with(() => async () => {
        order.push('fastify-body')
      })
      .with(() => new Recording('b'))
    await app.bootstrap()

    expect(order).toEqual(['a', 'b', 'fastify-body'])
  })

  it("lets a Fastify plugin's factory mount from context.app and still return its plugin", async () => {
    app = createWebApplication().with(context => {
      context.app.mount(newRouter('/from-factory').get('/', () => ({ ok: true })))
      return marking('x-marked')()
    })
    await app.bootstrap()

    const res = await app.fetch('/from-factory')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-marked')).toBe('yes')
  })

  it('serves a router mounted twice on one server once, as app.mount(...) does', async () => {
    const shared = newRouter('/shared').get('/', () => ({ shared: true }))

    class Twice extends HTTPPlugin {
      install({ app }: HTTPSetupContext): void {
        app.mount(shared)
        app.mount(shared)
      }
    }

    app = createWebApplication().with(() => new Twice())
    await app.bootstrap()

    expect((await app.fetch('/shared')).status).toBe(200)
  })

  it('keeps the group out of app.routeGroups, as a $route group is', async () => {
    app = createWebApplication().with(() => new Metrics())
    await app.bootstrap()

    expect(app.routeGroups.some(group => group.path === '/metrics')).toBe(false)
  })

  describe('on an ops server', () => {
    it('serves on the ops server whose o.with(...) installed it, and nowhere else', async () => {
      app = createWebApplication().install(Ops('admin', o => o.with(() => new Metrics())))
      await app.bootstrap()

      const admin = await app.ops.get('admin')!.fetch('/metrics')
      expect(admin.status).toBe(200)
      expect(await admin.json()).toEqual({ metrics: true })
      expect((await app.fetch('/metrics')).status).toBe(404)
    })

    it("refuses a router bound to an ops server from the application's own server", async () => {
      app = createWebApplication()
        .install(Ops('admin'))
        .with(() => new Bound('admin'))

      await expect(app.bootstrap()).rejects.toThrow(
        /^Cannot add route group "Metrics" to the application's own server: it is bound to "admin"/,
      )
      app = undefined
    })

    it('refuses a router bound to another server from an ops server', async () => {
      app = createWebApplication().install(Ops('admin', o => o.with(() => new Bound('metrics'))))

      await expect(app.bootstrap()).rejects.toThrow(
        /^Cannot add route group "Metrics" to ops server "admin": it is bound to "metrics"/,
      )
      app = undefined
    })
  })

  describe('app.mount outside a plugin slot', () => {
    const late = () => newRouter('/late').get('/', () => ({}))

    it("refuses it from a router's own plugin factory", async () => {
      app = createWebApplication().mount(
        newRouter('/owner')
          .plugin(context => {
            context.app.mount(late())
            return marking('x-never')()
          })
          .get('/', () => ({})),
      ) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(/^Cannot mount a router here: "app\.mount" is open only/)
      app = undefined
    })

    it('refuses it from a middleware factory', async () => {
      app = createWebApplication().useFn(context => {
        context.app.mount(late())
        return (_ctx: Context, next: () => void) => next()
      })

      await expect(app.bootstrap()).rejects.toThrow(/^Cannot mount a router here/)
      app = undefined
    })

    it('refuses it from a context kept past the slot', async () => {
      const keeper = new Keeper()
      app = createWebApplication().with(() => keeper)
      await app.bootstrap()

      expect(() => keeper.context!.app.mount(late())).toThrow(/^Cannot mount a router here/)
    })
  })

  describe('compiled like a mounted router', () => {
    it("denies with the router's own guards", async () => {
      class Guarded extends HTTPPlugin {
        install({ app }: HTTPSetupContext): void {
          app.mount(
            newRouter('/closed')
              .guards([DenyGuard])
              .get('/', () => ({ ok: true })),
          )
        }
      }

      app = createWebApplication().with(() => new Guarded())
      await app.bootstrap()

      expect((await app.fetch('/closed')).status).toBe(403)
    })

    it('runs the global guards', async () => {
      app = createWebApplication()
        .install(Guards(g => g.global(TokenGuard)))
        .with(() => new Metrics())
      await app.bootstrap()

      expect((await app.fetch('/metrics')).status).toBe(403)
      expect((await app.fetch('/metrics', { headers: { 'x-token': 'ok' } })).status).toBe(200)
    })

    it('takes part in the start-up check for a protected route with no authentication configured', async () => {
      class Secret extends HTTPPlugin {
        install({ app }: HTTPSetupContext): void {
          app.mount(
            newRouter('/secret')
              .authorize()
              .get('/', () => ({ ok: true })),
          )
        }
      }

      app = createWebApplication().with(() => new Secret())

      await expect(app.bootstrap()).rejects.toThrow(ErrAuthenticationRequired)
      app = undefined
    })

    // Registered with every other group, after the whole `.with(...)` loop: a plugin written after the one that
    // mounted still sees the route from its `onRoute` hook, which it would not if the route registered in its slot.
    it("registers after every plugin, so a later plugin's onRoute hook still sees it", async () => {
      const seen: string[] = []

      app = createWebApplication()
        .with(() => new Metrics())
        .with(() =>
          fp(
            async (instance: FastifyInstance) => {
              instance.addHook('onRoute', route => {
                seen.push(route.url)
              })
            },
            { name: 'collector' },
          ),
        )
      await app.bootstrap()

      expect(seen).toContain('/metrics')
    })

    it("installs a mounted router's own plugin in front of its routes only", async () => {
      class Stamped extends HTTPPlugin {
        install({ app }: HTTPSetupContext): void {
          app.mount(
            newRouter('/stamped')
              .plugin(marking('x-router-plugin'))
              .get('/', () => ({ stamped: true })),
            newRouter('/plain').get('/', () => ({ plain: true })),
          )
        }
      }

      app = createWebApplication().with(() => new Stamped())
      await app.bootstrap()

      expect((await app.fetch('/stamped')).headers.get('x-router-plugin')).toBe('yes')
      expect((await app.fetch('/plain')).headers.get('x-router-plugin')).toBeNull()
    })

    // The application resolved the router's plugin for its own mount: a plugin mounting the same router on another
    // server must not resolve it again, or that server would install it twice in front of the group.
    it("resolves a router's own plugin once when the application and a plugin both mount it", async () => {
      let resolved = 0
      const shared = newRouter('/shared')
        .plugin(() => {
          resolved++
          return marking('x-shared')()
        })
        .get('/', () => ({ shared: true }))

      class Sharing extends HTTPPlugin {
        install({ app }: HTTPSetupContext): void {
          app.mount(shared)
        }
      }

      app = createWebApplication()
        .install(Ops('admin', o => o.with(() => new Sharing())))
        .mount(shared) as WebApplication
      await app.bootstrap()

      expect(resolved).toBe(1)
      expect((await app.ops.get('admin')!.fetch('/shared')).headers.get('x-shared')).toBe('yes')
      expect((await app.fetch('/shared')).headers.get('x-shared')).toBe('yes')
    })

    it('flattens nested groups and resolves what the router injected', async () => {
      class Nested extends HTTPPlugin {
        install({ app }: HTTPSetupContext): void {
          app.mount(
            newRouter('/outer')
              .inject({ greeter: Greeter })
              .group('/inner', r => r.get('/', (_ctx, deps) => ({ text: deps.greeter.greet() }))),
          )
        }
      }

      app = createWebApplication().with(() => new Nested())
      await app.bootstrap()

      const res = await app.fetch('/outer/inner')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ text: 'hello' })
    })

    // A guard used by both an ordinary route and a plugin's must resolve through the one compiler `buildRouting()`
    // built: a singleton guard with no request-scoped dependencies is constructed once.
    it('shares one guard instance with an ordinary route', async () => {
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

      class Counted extends HTTPPlugin {
        install({ app }: HTTPSetupContext): void {
          app.mount(
            newRouter('/counted')
              .guards([CountingGuard])
              .get('/', () => ({ ok: true })),
          )
        }
      }

      const ordinary = new Router('/ordinary').guards([CountingGuard])
      ordinary.get('/', () => ({ ok: true }))

      app = createWebApplication()
        .with(() => new Counted())
        .mount(ordinary) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/counted')).status).toBe(200)
      expect((await app.fetch('/ordinary')).status).toBe(200)
      expect(constructions).toBe(1)
    })
  })

  it('is refused from a route group, which takes Fastify plugins only', async () => {
    app = createWebApplication().mount(
      newRouter('/owner')
        .plugin(() => new Metrics() as never)
        .get('/', () => ({})),
    ) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow(/^Cannot install an HTTPPlugin from "router\.plugin\(\.\.\.\)"/)
    app = undefined
  })

  it('types an HTTPPlugin factory as what .with(...) takes on any server, and not what a route group takes', () => {
    const factory: AdapterExtensionFactory<HTTPPlugin> = () => new Metrics()

    const typed = createWebApplication()
      .with(factory)
      .install(Ops('admin', o => o.with(factory)))
    // @ts-expect-error a route group takes Fastify plugins only
    newRouter('/x').plugin(() => new Metrics())

    expect(typeof typed.bootstrap).toBe('function')
  })
})
