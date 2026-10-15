import { Injectable } from '@caffeinejs/di'
import { ErrFeatureNotInstalled } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type AdapterExtensionFactory,
  type IContext,
  ErrAuthenticationRequired,
  type FastifyRouterTypes,
  type Guard,
  type GuardInput,
  Guards,
  HTTPPlugin,
  type HTTPSetupContext,
  type MiddlewareFn,
  Ops,
  Router,
  bindTo,
  createWebApplication,
  newRouter,
  type WebApplication,
} from '../index.js'

/**
 * Scenario: a plugin written against Caffeine alone. An `HTTPPlugin` registers in its `.with(...)` slot, and
 * `context.app` mounts routers and adds middleware where that slot belongs: on a server, or on a router. What a
 * Fastify plugin does in that slot is `plugins.test.ts`'s; a controller's `@Use(...)` is in its own files.
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

/** A middleware stamping `header` on what it covers. */
function stamp(header: string, value = 'yes'): MiddlewareFn {
  return (ctx, next) => {
    ctx.header(header, value)
    next()
  }
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

/** The simplest plugin: one router, mounted from `register`. Written for no adapter. */
class Metrics extends HTTPPlugin {
  register({ app }: HTTPSetupContext): void {
    app.mount(new Router('/metrics').get('/', () => ({ metrics: true })))
  }
}

/** Mounts a router bound to `server`, to see the binding refused. */
class Bound extends HTTPPlugin {
  readonly #server: string

  constructor(server: string) {
    super()
    this.#server = server
  }

  register({ app }: HTTPSetupContext): void {
    app.mount(new Router('/metrics').extend(bindTo(this.#server)).get('/', () => ({ metrics: true })))
  }
}

/** Keeps the context it was handed, to call `app` once the slot has closed. */
class Keeper extends HTTPPlugin {
  context: HTTPSetupContext | undefined

  register(context: HTTPSetupContext): void {
    this.context = context
  }
}

/** Mounts `/jobs` wherever it registers. */
class Nester extends HTTPPlugin {
  register({ app }: HTTPSetupContext): void {
    app.mount(new Router('/jobs').get('/', () => ({ jobs: true })))
  }
}

/** Adds a middleware stamping `header`, under `path` when one is given. */
class Stamping extends HTTPPlugin {
  readonly #header: string
  readonly #path: string | string[] | undefined

  constructor(header: string, path?: string | string[]) {
    super()
    this.#header = header
    this.#path = path
  }

  register({ app }: HTTPSetupContext): void {
    if (this.#path === undefined) {
      app.use(stamp(this.#header))
    } else {
      app.use(this.#path, stamp(this.#header))
    }
  }
}

/** Adds a middleware from a factory, counting its calls and keeping the context it was handed. */
class Building extends HTTPPlugin {
  calls = 0
  seen: HTTPSetupContext | undefined

  register({ app }: HTTPSetupContext): void {
    app.useFn(context => {
      this.calls++
      this.seen = context
      return stamp('x-built')
    })
  }
}

/** Mounts the routers it was built with, wherever it registers. */
class Mounter extends HTTPPlugin {
  readonly #routers: Router<any, any, any, any, any, never>[]

  constructor(...routers: Router<any, any, any, any, any, never>[]) {
    super()
    this.#routers = routers
  }

  register({ app }: HTTPSetupContext): void {
    app.mount(...this.#routers)
  }
}

describe('HTTPPlugin', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it("serves what register() mounted, on the application's own server", async () => {
    app = createWebApplication().with(() => new Metrics())
    await app.bootstrap()

    const res = await app.fetch('/metrics')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ metrics: true })
  })

  it('hands register() the setup context the factory got', async () => {
    let seen: HTTPSetupContext | undefined

    class Probe extends HTTPPlugin {
      register(context: HTTPSetupContext): void {
        seen = context
      }
    }

    app = createWebApplication().with(() => new Probe())
    await app.bootstrap()

    expect(seen?.container).toBe(app.container)
    expect(seen?.hasFeature('cookie')).toBe(true)
    expect(seen?.hasFeature('nothing')).toBe(false)
  })

  it('refuses the start when register() throws ErrFeatureNotInstalled, as a plugin factory does', async () => {
    class NeedsThing extends HTTPPlugin {
      register({ hasFeature }: HTTPSetupContext): void {
        if (!hasFeature('thing')) {
          throw new ErrFeatureNotInstalled('thing', 'Install it: ".install(Thing())"')
        }
      }
    }

    app = createWebApplication().with(() => new NeedsThing())

    await expect(app.bootstrap()).rejects.toThrow(ErrFeatureNotInstalled)
    app = undefined
  })

  it('registers in slot order, and before any Fastify plugin body runs', async () => {
    const order: string[] = []

    class Recording extends HTTPPlugin {
      readonly #name: string

      constructor(name: string) {
        super()
        this.#name = name
      }

      register(): void {
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
    const shared = new Router('/shared').get('/', () => ({ shared: true }))

    class Twice extends HTTPPlugin {
      register({ app }: HTTPSetupContext): void {
        app.mount(shared)
        app.mount(shared)
      }
    }

    app = createWebApplication().with(() => new Twice())
    await app.bootstrap()

    expect((await app.fetch('/shared')).status).toBe(200)
  })

  // `app.mount(...)` gave the server its groups before any slot ran: compiling the router again for the plugin would
  // register every route twice, and Fastify refuses the second.
  it('serves a router the application mounted once when a plugin on the same server mounts it again', async () => {
    const shared = new Router('/shared').get('/', () => ({ shared: true }))

    app = createWebApplication()
      .mount(shared)
      .with(() => new Mounter(shared)) as WebApplication
    await app.bootstrap()

    expect((await app.fetch('/shared')).status).toBe(200)
  })

  // Nested under another router, it is a second place, not the same one: both are served.
  it('still serves a router where the application nested it when a plugin mounts it at the top', async () => {
    const shared = new Router('/shared').get('/', () => ({ shared: true }))

    app = createWebApplication()
      .mount(new Router('/outer').mount(shared))
      .with(() => new Mounter(shared)) as WebApplication
    await app.bootstrap()

    expect((await app.fetch('/outer/shared')).status).toBe(200)
    expect((await app.fetch('/shared')).status).toBe(200)
  })

  it('keeps the group out of app.routeGroups, as a $route group is', async () => {
    app = createWebApplication().with(() => new Metrics())
    await app.bootstrap()

    expect(app.routeGroups.some(group => group.path === '/metrics')).toBe(false)
  })

  it('types an HTTPPlugin factory as what .with(...) takes on a server and on a router', () => {
    const factory: AdapterExtensionFactory<HTTPPlugin> = () => new Metrics()

    const typed = createWebApplication()
      .with(factory)
      .install(Ops('admin', o => o.with(factory)))
    new Router('/typed').with(factory)
    newRouter('/typed-bound').with(factory)

    expect(typeof typed.bootstrap).toBe('function')
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

    it('serves a router once on the ops server the application and its plugin both put it on', async () => {
      const shared = new Router('/shared-admin').extend(bindTo('admin')).get('/', () => ({ shared: true }))

      app = createWebApplication()
        .install(Ops('admin', o => o.with(() => new Mounter(shared))))
        .mount(shared) as WebApplication
      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/shared-admin')).status).toBe(200)
      expect((await app.fetch('/shared-admin')).status).toBe(404)
    })

    // A router whose nested router is bound elsewhere is split: its own group on the application's server, the
    // nested one on `admin`. A plugin on `admin` mounting it adds the group `admin` lacks and skips the one it serves.
    it("adds a split router's own routes to the server whose plugin mounts it", async () => {
      const split = new Router('/split')
        .get('/', () => ({ split: true }))
        .mount(new Router('/child').extend(bindTo('admin')).get('/', () => ({ child: true })))

      app = createWebApplication()
        .install(Ops('admin', o => o.with(() => new Mounter(split))))
        .mount(split) as WebApplication
      await app.bootstrap()

      const admin = app.ops.get('admin')!
      expect((await admin.fetch('/split')).status).toBe(200)
      expect((await admin.fetch('/split/child')).status).toBe(200)
      expect((await app.fetch('/split')).status).toBe(200)
      expect((await app.fetch('/split/child')).status).toBe(404)
    })
  })

  describe('app.use and app.useFn on a server', () => {
    it("adds middleware after the application's own", async () => {
      const order =
        (value: string): MiddlewareFn =>
        (ctx, next) => {
          ctx.appendHeader('x-order', value)
          next()
        }

      class Ordered extends HTTPPlugin {
        register({ app }: HTTPSetupContext): void {
          app.use(order('plugin'))
        }
      }

      app = createWebApplication()
        .use(order('app'))
        .with(() => new Ordered())
        .mount(new Router('/order').get('/', () => ({}))) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/order')).headers.get('x-order')).toBe('app, plugin')
    })

    it('stays on the server it was registered on', async () => {
      app = createWebApplication()
        .install(Ops('admin', o => o.with(() => new Stamping('x-admin'))))
        .mount(
          new Router('/own').get('/', () => ({})),
          new Router('/ops').extend(bindTo('admin')).get('/', () => ({})),
        ) as WebApplication
      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/ops')).headers.get('x-admin')).toBe('yes')
      expect((await app.fetch('/own')).headers.get('x-admin')).toBeNull()
    })

    it("matches a path of the server's own and takes the adapter's hook", async () => {
      class Hooked extends HTTPPlugin<FastifyRouterTypes> {
        register({ app }: HTTPSetupContext<unknown, FastifyRouterTypes>): void {
          app.use('/only', stamp('x-hooked'), { hook: 'preHandler' })
        }
      }

      app = createWebApplication()
        .with(() => new Hooked())
        .mount(
          new Router('/only').get('/', () => ({})),
          new Router('/other').get('/', () => ({})),
        ) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/only')).headers.get('x-hooked')).toBe('yes')
      expect((await app.fetch('/other')).headers.get('x-hooked')).toBeNull()
    })

    it('builds a useFn middleware once, outside the slot', async () => {
      const building = new Building()
      app = createWebApplication()
        .with(() => building)
        .mount(new Router('/built').get('/', () => ({}))) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/built')).headers.get('x-built')).toBe('yes')
      expect(building.calls).toBe(1)
      expect(() => building.seen!.app.mount(new Router('/late'))).toThrow(/^Cannot call "app\.mount" here/)
    })

    it('refuses use and useFn from a context kept past the slot', async () => {
      const keeper = new Keeper()
      app = createWebApplication().with(() => keeper)
      await app.bootstrap()

      expect(() => keeper.context!.app.use(stamp('x-late'))).toThrow(/^Cannot call "app\.use" here/)
      expect(() => keeper.context!.app.useFn(() => stamp('x-late'))).toThrow(/^Cannot call "app\.useFn" here/)
    })

    // The slot closes on every way out of it: a plugin that kept its context cannot mount after a later one failed.
    it('closes the slot when a later plugin fails', async () => {
      const keeper = new Keeper()
      app = createWebApplication()
        .with(() => keeper)
        .with(() => {
          throw new Error('boom')
        })

      await expect(app.bootstrap()).rejects.toThrow('boom')
      expect(() => keeper.context!.app.mount(new Router('/late'))).toThrow(/^Cannot call "app\.mount" here/)
      app = undefined
    })
  })

  describe('app.mount outside a plugin slot', () => {
    const late = () => new Router('/late').get('/', () => ({}))

    it('refuses it from a middleware factory', async () => {
      app = createWebApplication().useFn(context => {
        context.app.mount(late())
        return (_ctx: IContext, next: () => void) => next()
      })

      await expect(app.bootstrap()).rejects.toThrow(/^Cannot call "app\.mount" here/)
      app = undefined
    })

    it('refuses it from a context kept past the slot', async () => {
      const keeper = new Keeper()
      app = createWebApplication().with(() => keeper)
      await app.bootstrap()

      expect(() => keeper.context!.app.mount(late())).toThrow(/^Cannot call "app\.mount" here/)
    })
  })

  describe('on a router', () => {
    it('nests what it mounts under the router, behind its guards', async () => {
      const admin = new Router('/admin')
        .guards([TokenGuard])
        .with(() => new Nester())
        .get('/', () => ({ admin: true }))

      app = createWebApplication().mount(admin) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/admin/jobs')).status).toBe(403)
      const allowed = await app.fetch('/admin/jobs', { headers: { 'x-token': 'ok' } })
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toEqual({ jobs: true })
      expect((await app.fetch('/jobs')).status).toBe(404)
    })

    it('serves what it nests on the server the router is bound to', async () => {
      const bound = new Router('/admin-ops')
        .extend(bindTo('admin'))
        .with(() => new Nester())
        .get('/', () => ({}))

      app = createWebApplication().install(Ops('admin')).mount(bound) as WebApplication
      await app.bootstrap()

      expect((await app.ops.get('admin')!.fetch('/admin-ops/jobs')).status).toBe(200)
      expect((await app.fetch('/admin-ops/jobs')).status).toBe(404)
    })

    it("nests what the router's own factory mounts", async () => {
      const host = new Router('/host')
        .with(({ app }) => {
          app.mount(new Router('/direct').get('/', () => ({ direct: true })))
          return new Nester()
        })
        .get('/', () => ({}))

      app = createWebApplication().mount(host) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/host/direct')).status).toBe(200)
      expect((await app.fetch('/host/jobs')).status).toBe(200)
    })

    it("runs use middleware in front of the router's routes alone, nested groups included", async () => {
      const scoped = new Router('/scoped')
        .with(() => new Stamping('x-scoped'))
        .get('/', () => ({}))
        .group('/child', child => child.get('/', () => ({})))

      app = createWebApplication().mount(
        scoped,
        new Router('/plain').get('/', () => ({})),
      ) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/scoped')).headers.get('x-scoped')).toBe('yes')
      expect((await app.fetch('/scoped/child')).headers.get('x-scoped')).toBe('yes')
      expect((await app.fetch('/plain')).headers.get('x-scoped')).toBeNull()
    })

    it('matches a path relative to the router', async () => {
      const relative = new Router('/rel')
        .with(() => new Stamping('x-rel', ['/jobs', 'tasks']))
        .get('/jobs', () => ({}))
        .get('/tasks', () => ({}))
        .get('/other', () => ({}))

      app = createWebApplication().mount(relative) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/rel/jobs')).headers.get('x-rel')).toBe('yes')
      expect((await app.fetch('/rel/tasks')).headers.get('x-rel')).toBe('yes')
      expect((await app.fetch('/rel/other')).headers.get('x-rel')).toBeNull()
    })

    // One router nested under two parents is one plugin resolution, with a relative path that starts at a different
    // place in each group.
    it('rebases under each parent a router is nested in', async () => {
      const child = new Router('/child')
        .with(() => new Stamping('x-child', '/x'))
        .get('/x', () => ({}))
        .get('/y', () => ({}))

      app = createWebApplication().mount(new Router('/a').mount(child), new Router('/b').mount(child)) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/a/child/x')).headers.get('x-child')).toBe('yes')
      expect((await app.fetch('/b/child/x')).headers.get('x-child')).toBe('yes')
      expect((await app.fetch('/a/child/y')).headers.get('x-child')).toBeNull()
    })

    it('keeps a parameter and drops a constraint in the base', async () => {
      const numbered = new Router('/num/:id(^\\d+)').with(() => new Stamping('x-num', '/x')).get('/x', () => ({}))

      app = createWebApplication().mount(numbered) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/num/7/x')).headers.get('x-num')).toBe('yes')
    })

    it('refuses a relative path under an optional parameter, which has no prefix', async () => {
      const optional = new Router('/opt/:id?').with(() => new Stamping('x-opt', '/x')).get('/', () => ({}))

      app = createWebApplication().mount(optional) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(/^Cannot add middleware "\/x" under "\/opt\/:id\?"/)
      app = undefined
    })

    it("builds a router's useFn middleware once, outside the slot", async () => {
      const building = new Building()
      const built = new Router('/built')
        .with(() => building)
        .get('/', () => ({}))
        .group('/child', child => child.get('/', () => ({})))

      app = createWebApplication().mount(built) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/built')).headers.get('x-built')).toBe('yes')
      expect((await app.fetch('/built/child')).headers.get('x-built')).toBe('yes')
      expect(building.calls).toBe(1)
      expect(() => building.seen!.app.mount(new Router('/late'))).toThrow(/^Cannot call "app\.mount" here/)
    })

    it('nests a router mounted twice once', async () => {
      const fresh = new Router('/fresh').get('/', () => ({ fresh: true }))
      const declared = new Router('/declared').get('/', () => ({ declared: true }))

      class Twice extends HTTPPlugin {
        register({ app }: HTTPSetupContext): void {
          app.mount(fresh, fresh, declared)
        }
      }

      const host = new Router('/twice').mount(declared).with(() => new Twice())

      app = createWebApplication().mount(host) as WebApplication
      await app.bootstrap()

      expect((await app.fetch('/twice/fresh')).status).toBe(200)
      expect((await app.fetch('/twice/declared')).status).toBe(200)
    })

    // What a plugin mounts is kept by the application, never written into the router: a router whose plugin mounts a
    // new router each time would otherwise carry both into the second application, and fail there on a duplicate.
    it('starts from what the router declared in every application', async () => {
      class FreshNester extends HTTPPlugin {
        register({ app }: HTTPSetupContext): void {
          app.mount(new Router('/inner').get('/', () => ({ inner: true })))
        }
      }

      const shared = new Router('/every').with(() => new FreshNester())

      for (let run = 0; run < 2; run++) {
        const each = createWebApplication().mount(shared) as WebApplication
        await each.bootstrap()
        expect((await each.fetch('/every/inner')).status).toBe(200)
        await each.close()
      }
    })

    it("resolves the plugins of a router a server's plugin mounted", async () => {
      class Outer extends HTTPPlugin {
        register({ app }: HTTPSetupContext): void {
          app.mount(new Router('/outer-mounted').with(() => new Nester()))
        }
      }

      app = createWebApplication().with(() => new Outer())
      await app.bootstrap()

      expect((await app.fetch('/outer-mounted/jobs')).status).toBe(200)
    })

    it("closes a router's slot when its plugin fails", async () => {
      const keeper = new Keeper()
      const failing = new Router('/failing')
        .with(() => keeper)
        .with(() => {
          throw new Error('router boom')
        })
        .get('/', () => ({}))

      app = createWebApplication().mount(failing) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow('router boom')
      expect(() => keeper.context!.app.mount(new Router('/late'))).toThrow(/^Cannot call "app\.mount" here/)
      app = undefined
    })

    it('refuses a value that is not a plugin factory', () => {
      expect(() => new Router('/x').with({} as never)).toThrow(
        'Cannot register an HTTP plugin: expected a plugin factory function, got object',
      )
    })

    // Two plugins can close a loop that no `.mount(...)` call shows. Refused at start-up, naming the loop, rather than
    // walked until the stack runs out.
    it("refuses a loop two routers' plugins close", async () => {
      const a = new Router('/loop-a').get('/', () => ({ a: true }))
      const b = new Router('/loop-b').get('/', () => ({ b: true }))
      a.with(() => new Mounter(b))
      b.with(() => new Mounter(a))

      app = createWebApplication().mount(a) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(
        /^Cannot nest router "\/loop-a" in itself: "\/loop-a" → "\/loop-b" → "\/loop-a"/,
      )
      app = undefined
    })

    it('refuses a router whose plugin mounts the router itself', async () => {
      const self = new Router('/self').get('/', () => ({ self: true }))
      self.with(() => new Mounter(self))

      app = createWebApplication().mount(self) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(/^Cannot nest router "\/self" in itself: "\/self" → "\/self"/)
      app = undefined
    })
  })

  describe('compiled like a mounted router', () => {
    it("denies with the router's own guards", async () => {
      class Guarded extends HTTPPlugin {
        register({ app }: HTTPSetupContext): void {
          app.mount(new Router('/closed').guards([DenyGuard]).get('/', () => ({ ok: true })))
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
        register({ app }: HTTPSetupContext): void {
          app.mount(new Router('/secret').authorize().get('/', () => ({ ok: true })))
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
      class Stamped extends HTTPPlugin<FastifyRouterTypes> {
        register({ app }: HTTPSetupContext<unknown, FastifyRouterTypes>): void {
          app.mount(
            newRouter('/stamped')
              .with(marking('x-router-plugin'))
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
        .with(() => {
          resolved++
          return marking('x-shared')()
        })
        .get('/', () => ({ shared: true }))

      class Sharing extends HTTPPlugin<FastifyRouterTypes> {
        register({ app }: HTTPSetupContext<unknown, FastifyRouterTypes>): void {
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
        register({ app }: HTTPSetupContext): void {
          app.mount(
            new Router('/outer')
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
        register({ app }: HTTPSetupContext): void {
          app.mount(new Router('/counted').guards([CountingGuard]).get('/', () => ({ ok: true })))
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
})
