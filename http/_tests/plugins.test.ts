import { kFeatureConfigure, kFeatureName, newConfiguration, type Feature } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { newNoopLogger, type Logger } from '@caffeinejs/application/logger'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC, token } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { version } from '../core/constraints/route.js'
import { ErrHTTPBadRequest } from '../core/error/http.js'
import { healthProbes } from '../core/health/index.js'
import { Router, type AnyRouter } from '../core/routing/programmatic/programmatic.js'
import { Controller, Get, Use } from '../decorators/index.js'
import { HTTPPlugin, type WebApplication } from '../index.js'
import { node } from '../platform/node.testkit.js'
import type { HTTPSetupContext } from '../plugin.js'

/**
 * What an application installs on its server: the plugins its `.with(...)` factories produce.
 *
 * These tests pin the ordering model — the order `.with(...)` was written, whatever a factory awaits, with
 * nothing sorted by what a plugin is — the slots the framework keeps at both ends, that an `.install(...)`
 * never takes a slot at all, and a plugin belonging to one route group instead of the whole server.
 */

/**
 * A plugin named `name` that stamps a response header.
 *
 * Registered on the root server, it covers every route; registered by a router or a controller, only that group's.
 */
function stamping(name: string, header: string, log?: string[]) {
  return () =>
    new (class extends HTTPPlugin {
      override readonly name = name

      register({ server }: HTTPSetupContext): void {
        log?.push(name)
        server.hook('onRequest', ctx => void ctx.header(header, 'yes'))
      }
    })()
}

/** A plugin stamping `header` on every response it covers. */
class Marking extends HTTPPlugin {
  override readonly name: string
  readonly #header: string
  readonly #value: string

  constructor(header: string, value = 'yes') {
    super()
    this.#header = header
    this.#value = value
    this.name = `marking:${header}`
  }

  register({ server }: HTTPSetupContext): void {
    server.hook('onRequest', ctx => void ctx.header(this.#header, this.#value))
  }
}

describe('plugin registration', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The whole ordering model. There is no stage to jump a band with, so what a reader sees in the chain is
  // what the server gets — which is why a feature that must precede another is simply extended first.
  it('registers plugins in the order .with() was written', async () => {
    const log: string[] = []

    app = createWebApplication({ adapter: node() })
      .with(stamping('third', 'x-third', log))
      .with(stamping('first', 'x-first', log))
      .with(stamping('second', 'x-second', log))

    await app.bootstrap()

    expect(log).toEqual(['third', 'first', 'second'])
  })

  // Where `.install(...)` sits in the chain cannot matter: every feature configures before the container
  // initializes, and every factory runs at setup, after it — so the feature's binding is there for the factory
  // whichever way round the calls were written.
  it('yields the same wiring whether .install() is written before or after .with()', async () => {
    const kGreeting = token<string>(Symbol('order-free.greeting'))

    const greeting = (): Feature => ({
      [kFeatureName]: 'greeting',
      [kFeatureConfigure](kit) {
        kit.container.bind(kGreeting, t => t.toValue('hello'))
      },
    })
    const reading = ({ container }: HTTPSetupContext) => new Marking('x-greeting', container.get(kGreeting))

    const before = createWebApplication({ adapter: node() }).install(greeting()).with(reading)
    const after = createWebApplication({ adapter: node() }).with(reading).install(greeting())

    try {
      await before.bootstrap()
      await after.bootstrap()

      expect((await before.request('/nothing-here')).headers.get('x-greeting')).toBe('hello')
      expect((await after.request('/nothing-here')).headers.get('x-greeting')).toBe('hello')
    } finally {
      await before.close()
      await after.close()
    }
  })

  // A factory runs before the server exists, so the same answer sits on its context.
  it('answers hasFeature on the setup context handed to factories', async () => {
    let seen: boolean[] = []

    app = createWebApplication({ adapter: node() }).with(context => {
      seen = [context.hasFeature('cookie'), context.hasFeature('nope')]
      return new Marking('x-has-feature-probe')
    })

    await app.bootstrap()

    expect(seen).toEqual([true, false])
  })

  // The logger feature configures alongside every other feature, so the logger is only final once they all have.
  // What the factories are handed is built after that, which is why it carries the one `.logger(...)` asked for
  // rather than the default the application started with. Each gets a server of its own, open while it registers.
  it('hands every factory a context carrying the configured logger', async () => {
    const custom: Logger = { ...newNoopLogger() }
    const seen: { first?: HTTPSetupContext; second?: HTTPSetupContext } = {}

    app = createWebApplication({ adapter: node() })
      .logger(b => b.use(custom))
      .with(context => {
        seen.first = context
        return new Marking('x-context-probe')
      })
      .with(context => {
        seen.second = context
        return new Marking('x-context-probe-2')
      })

    await app.bootstrap()

    expect([seen.first?.logger, seen.second?.logger]).toEqual([custom, custom])
    expect([seen.first?.container, seen.second?.container]).toEqual([app.container, app.container])
    expect(seen.first?.server).not.toBe(seen.second?.server)
  })

  // An app-level factory is called once the container has initialized — not while features configure, where
  // this would throw `ErrInvalidContainerState`. Resolving here, inside the factory itself rather than inside the
  // plugin body, is exactly the case that used to be broken.
  it('resolves from the container inside an app-level factory', async () => {
    const kGreeting = token<string>(Symbol('greeting'))
    const container = new CaffeineIoC()
    container.bind(kGreeting, t => t.toValue('hello'))

    const factory = ({ container }: HTTPSetupContext) => new Marking('x-greeting', container.get(kGreeting))

    app = createWebApplication({ adapter: node(), container }).with(factory)

    await expect(app.bootstrap()).resolves.not.toThrow()

    expect((await app.request('/nothing-here')).headers.get('x-greeting')).toBe('hello')
  })

  // The order a plugin ends up in is the order its `.with(...)` was written — not the order its factory happens to
  // finish resolving. An awaiting factory must not jump ahead of, or fall behind, a synchronous one written before
  // or after it.
  it('keeps an awaiting app-level factory at its written position', async () => {
    const log: string[] = []

    const awaiting = async () => {
      await new Promise(resolve => setTimeout(resolve, 10))

      return stamping('awaiting', 'x-awaiting', log)()
    }

    app = createWebApplication({ adapter: node() })
      .with(stamping('before', 'x-before', log))
      .with(awaiting)
      .with(stamping('after', 'x-after', log))

    await app.bootstrap()

    expect(log).toEqual(['before', 'awaiting', 'after'])
  })

  // The head slot: error handling is installed ahead of everything the application installed, so a route that
  // throws is answered by the framework handler rather than by a bare default.
  it('covers a route with the framework error handler whatever a plugin registered', async () => {
    @Controller('/head-slot')
    class HeadSlotController {
      @Get('/boom')
      boom(): never {
        throw new ErrHTTPBadRequest('nope')
      }
    }
    void [HeadSlotController]

    app = createWebApplication({ adapter: node() }).with(stamping('stamp', 'x-stamp'))

    await app.bootstrap()

    const res = await app.request('/head-slot/boom')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-stamp')).toBe('yes')
    expect(await res.json()).toMatchObject({ detail: 'nope' })
  })

  // The tail slot: the not-found answer is contributed last, so it sees whatever the plugins decorated the
  // server with and still answers a URL no route matched.
  it('answers an unmatched URL from the not-found handler registered after every plugin', async () => {
    app = createWebApplication({ adapter: node() }).with(stamping('stamp', 'x-stamp'))

    await app.bootstrap()

    const res = await app.request('/nothing-here')

    expect(res.status).toBe(404)
    expect(res.headers.get('x-stamp')).toBe('yes')
  })
})

describe('scoped plugin registration', () => {
  // Widened: `mount()` re-types the application with the routes it took, and the holder outlives the call.
  let app: WebApplication<any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // A router's plugins register on the server it is mounted on, after that server's own: they may rely on them.
  it("registers a router's plugins after the server's own", async () => {
    const log: string[] = []
    app = createWebApplication({ adapter: node() })
      .with(stamping('server', 'x-server', log))
      .mount(new Router('/order').with(stamping('router', 'x-router', log)).get('/', () => ({ ok: true })))
    await app.bootstrap()

    expect(log).toEqual(['server', 'router'])
  })

  // Its plugins run whatever it declares itself: what they mount is the router's to serve.
  it('serves what the plugin of a router with no routes of its own mounts', async () => {
    const empty = new Router('/empty').with(
      () =>
        new (class extends HTTPPlugin {
          register({ server }: HTTPSetupContext): void {
            server.mount(new Router('/inner').get('/', () => ({ inner: true })))
          }
        })(),
    )
    app = createWebApplication({ adapter: node() }).mount(empty)
    await app.bootstrap()

    const res = await app.request('/empty/inner')
    expect([res.status, await res.json()]).toEqual([200, { inner: true }])
  })

  // A router the application and a server plugin both mount is served once, with what its own plugin mounted.
  it('serves once what a router plugin mounts when a server plugin mounts that router too', async () => {
    const child = new Router('/child').get('/', () => ({ child: true }))
    const api = new Router('/api').with(
      () =>
        new (class extends HTTPPlugin {
          register({ server }: HTTPSetupContext): void {
            server.mount(child)
          }
        })(),
    )
    app = createWebApplication({ adapter: node() })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              server.mount(api)
            }
          })(),
      )
      .mount(api)
    await app.bootstrap()

    const res = await app.request('/api/child')
    expect([res.status, await res.json()]).toEqual([200, { child: true }])
  })

  // A middleware factory gets the context its plugin registered with: the scope, not the server's root.
  it("hands a router plugin's middleware factory the router's scope", async () => {
    const seen: string[] = []
    const router = new Router('/admin')
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              server.useFn(({ server: at }) => {
                seen.push(at.prefix)
                return (_ctx, next) => next()
              })
            }
          })(),
      )
      .get('/', () => ({ ok: true }))
    app = createWebApplication({ adapter: node() }).mount(router)
    await app.bootstrap()

    expect(seen).toEqual(['/admin'])
  })

  // A server hook belongs to the server, whatever routes its scope holds: one a plugin acquires a resource in must run.
  it('runs the server hooks of a router plugin whose router serves no route', async () => {
    const seen: string[] = []
    const empty = new Router('/empty').with(
      () =>
        new (class extends HTTPPlugin {
          register({ server }: HTTPSetupContext): void {
            server.hook('onReady', () => void seen.push('ready'))
            server.hook('onClose', () => void seen.push('close'))
          }
        })(),
    )
    const built = createWebApplication({ adapter: node() }).mount(empty)
    await built.bootstrap()
    await built.close()

    expect(seen).toEqual(['ready', 'close'])
  })

  // A place is the whole mount chain: one router under two parents at one path registers in each.
  it('registers a router under two parents at one path once for each parent', async () => {
    let registered = 0
    const child = new Router('/child')
      .with(
        () =>
          new (class extends HTTPPlugin {
            register(): void {
              registered++
            }
          })(),
      )
      .get('/', () => ({ ok: true }))
    app = createWebApplication({ adapter: node() }).mount(
      new Router('/api').config(version('1.0.0')).mount(child),
      new Router('/api').config(version('2.0.0')).mount(child),
    )
    await app.bootstrap()

    expect(registered).toBe(2)
  })

  // A router's group prefix leads its routes after its parent's path: its plugins see the path its routes start at,
  // and what they mount or declare nests there. The server takes one trailing slash off a prefix, so a second one
  // stays as an empty segment, as it did before plugins could see it.
  it.each([
    ['/v1', '/pets', '/api/v1/pets'],
    ['/v1/', '/pets', '/api/v1/pets'],
    ['/v1//', '/pets', '/api/v1//pets'],
    ['/v1//', '', '/api/v1/'],
  ])('scopes a router prefixed %j with path %j at its prefix and path', async (prefix, path, at) => {
    const seen: string[] = []
    const prefixed = new Router(path)
      .extend((group: { prefix(prefix: string): unknown }) => {
        group.prefix(prefix)
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              seen.push(server.prefix)
              server.mount(
                new Router('/x').get('/', () => ({ x: true })),
                new Router().get('/bare', () => ({ bare: true })),
              )
            }
          })(),
      )
      .get('/', () => ({ pets: true }))
      .mount(new Router('/kids').get('/', () => ({ kids: true })))
    app = createWebApplication({ adapter: node() }).mount(new Router('/api').mount(prefixed))
    await app.bootstrap()

    expect(seen).toEqual([at])
    expect(
      await Promise.all([at, `${at}/x`, `${at}/bare`, `${at}/kids`].map(async p => (await app!.request(p)).status)),
    ).toEqual([200, 200, 200, 200])
  })

  // An empty group prefix adds nothing: the child nests under its parent's path as written, an empty segment the
  // parent's prefix ends with included.
  it('nests a child with an empty group prefix under a parent whose prefix ends in an empty segment', async () => {
    const seen: string[] = []
    const child = new Router('/child')
      .extend((group: { prefix(prefix: string): unknown }) => {
        group.prefix('')
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              seen.push(server.prefix)
            }
          })(),
      )
      .get('/', () => ({ child: true }))
    const parent = new Router('')
      .extend((group: { prefix(prefix: string): unknown }) => {
        group.prefix('/v2//')
      })
      .get('/own', () => ({ own: true }))
      .mount(child)
    app = createWebApplication({ adapter: node() }).mount(parent)
    await app.bootstrap()

    expect([seen, (await app.request('/v2//own')).status, (await app.request('/v2//child')).status]).toEqual([
      ['/v2//child'],
      200,
      200,
    ])
  })

  // A path given to mount(...) is where the router is mounted, as a group around it would be: its group prefix comes
  // after it, and both forms serve and scope the router at one path.
  it.each([
    ['mount(path, router)', (child: AnyRouter) => new Router('/api').mount('/external', child)],
    ['a group around it', (child: AnyRouter) => new Router('/api').group('/external', g => g.mount(child))],
  ])('scopes a prefixed router mounted with %s after the mount path', async (_, mount) => {
    const seen: string[] = []
    const child = new Router('/things')
      .extend((group: { prefix(prefix: string): unknown }) => {
        group.prefix('/v1')
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              seen.push(server.prefix)
            }
          })(),
      )
      .get('/', () => ({ things: true }))
    app = createWebApplication({ adapter: node() }).mount(mount(child))
    await app.bootstrap()

    expect([seen, (await app.request('/api/external/v1/things')).status]).toEqual([['/api/external/v1/things'], 200])
  })

  // Its plugins' scope is where its routes are: a trailing slash on the mount path joins as its routes join it.
  it('scopes a router with an empty group prefix where its routes are when mounted at a path ending in a slash', async () => {
    const seen: string[] = []
    const child = new Router('/child')
      .extend((group: { prefix(prefix: string): unknown }) => {
        group.prefix('')
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              seen.push(server.prefix)
              server.mount(new Router('/extra').get('/', () => ({ extra: true })))
            }
          })(),
      )
      .get('/', () => ({ child: true }))
    app = createWebApplication({ adapter: node() }).mount(new Router().mount('/api/', child))
    await app.bootstrap()

    expect([seen, (await app.request('/api/child')).status, (await app.request('/api/child/extra')).status]).toEqual([
      ['/api/child'],
      200,
      200,
    ])
  })

  // A configurer runs once per place: compiling what a router's plugin mounted reuses the router's own options.
  it("runs a router's configurer once when its plugin mounts a router under it", async () => {
    let calls = 0
    const parent = new Router('/conf')
      .config(() => {
        calls++
      })
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              server.mount(new Router('/child').get('/', () => ({ child: true })))
            }
          })(),
      )
      .get('/', () => ({ parent: true }))
    app = createWebApplication({ adapter: node() }).mount(parent)
    await app.bootstrap()

    expect([calls, (await app.request('/conf/child')).status]).toEqual([1, 200])
  })

  // A plugin sees what the scopes around it registered: the server's plugins, then the routers it is nested in.
  it("answers hasPlugin for the plugins of the scopes around a router's plugin, and not a sibling's", async () => {
    const seen: boolean[] = []
    const asking = new Router('/asking')
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ server }: HTTPSetupContext): void {
              seen.push(
                server.hasPlugin('server-named'),
                server.hasPlugin('parent-named'),
                server.hasPlugin('sibling-named'),
              )
            }
          })(),
      )
      .get('/', () => ({ ok: true }))
    app = createWebApplication({ adapter: node() })
      .with(stamping('server-named', 'x-a'))
      .mount(
        new Router('/sibling').with(stamping('sibling-named', 'x-b')).get('/', () => ({ ok: true })),
        new Router('/parent').with(stamping('parent-named', 'x-c')).mount(asking),
      )
    await app.bootstrap()

    expect(seen).toEqual([true, true, false])
  })

  // The capability the extension mechanism did not have. A route group has a plugin scope of its own, so
  // the same plugin covers that group's routes and no others when it is registered there.
  it('keeps a router-installed plugin inside that router', async () => {
    const pets = new Router('/scoped-pets').with(stamping('pets-stamp', 'x-pets')).get('/', () => ({ ok: true }))

    // Mounted next to a plugin-scoped router all the same.
    const orders = new Router('/scoped-orders').get('/', () => ({ ok: true }))

    app = createWebApplication({ adapter: node() }).mount(pets, orders)

    await app.bootstrap()

    expect((await app.request('/scoped-pets')).headers.get('x-pets')).toBe('yes')
    expect((await app.request('/scoped-orders')).headers.get('x-pets')).toBeNull()
  })

  // A nested group is flattened into its own context, so inheritance is carried rather than encapsulated —
  // `router.with(...)` reaches the groups below it the way `router.extend(...)` configuration does.
  it('reaches a nested group from the router that installed the plugin', async () => {
    const shop = new Router('/scoped-shop').with(stamping('shop-stamp', 'x-shop')).get('/', () => ({ ok: true }))

    shop.group('/items', items => items.get('/', () => ({ ok: true })))

    app = createWebApplication({ adapter: node() }).mount(shop)

    await app.bootstrap()

    expect((await app.request('/scoped-shop')).headers.get('x-shop')).toBe('yes')
    expect((await app.request('/scoped-shop/items')).headers.get('x-shop')).toBe('yes')
  })

  it('keeps a controller-installed plugin inside that controller', async () => {
    @Use(stamping('admin-stamp', 'x-admin'))
    @Controller('/scoped-admin')
    class AdminController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }

    @Controller('/scoped-public')
    class PublicController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [AdminController, PublicController]

    app = createWebApplication({ adapter: node() })

    await app.bootstrap()

    expect((await app.request('/scoped-admin')).headers.get('x-admin')).toBe('yes')
    expect((await app.request('/scoped-public')).headers.get('x-admin')).toBeNull()
  })

  // Decorators apply bottom-up, so the `@Use` below `@Controller` is recorded first. A plugin may rely on what an
  // earlier one registered, so a reader must be able to trust the order the decorators are written in.
  it("installs a controller's @Use plugins in the order written, on either side of @Controller", async () => {
    const log: string[] = []

    @Use(stamping('stacked-above', 'x-above', log))
    @Controller('/scoped-stacked')
    @Use(stamping('stacked-below', 'x-below', log))
    class StackedController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void StackedController

    app = createWebApplication({ adapter: node() })

    await app.bootstrap()

    const res = await app.request('/scoped-stacked')

    expect(res.headers.get('x-above')).toBe('yes')
    expect(res.headers.get('x-below')).toBe('yes')
    expect(log).toEqual(['stacked-above', 'stacked-below'])
  })

  // A plugin with no name a caller chose is registered once per call, even from the same factory —
  // nothing dedupes on the factory's identity the way a feature dedupes on `kFeatureName`: with no name, there is
  // nothing for the guard below to collide on.
  it('registers an unnamed plugin once per call, even for the same factory', async () => {
    const log: string[] = []
    const twice = () =>
      new (class extends HTTPPlugin {
        register(): void {
          log.push('twice')
        }
      })()

    app = createWebApplication({ adapter: node() }).with(twice).with(twice)

    await app.bootstrap()

    expect(log).toEqual(['twice', 'twice'])
  })

  // Registering a plugin twice is the user's to decide: both register, and both run.
  it('registers two plugins of one name a router installs, and runs both', async () => {
    const twice = new Router('/twice-group')
      .with(stamping('twice-group', 'x-first'))
      .with(stamping('twice-group', 'x-second'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication({ adapter: node() }).mount(twice)
    await app.bootstrap()

    const res = await app.request('/twice-group')
    expect([res.headers.get('x-first'), res.headers.get('x-second')]).toEqual(['yes', 'yes'])
  })

  it('keeps the plugins of two routers apart, one per group', async () => {
    const pets = new Router('/inst-pets').with(stamping('inst', 'x-inst')).get('/', () => ({ ok: true }))
    const orders = new Router('/inst-orders')
      .with(stamping('inst-orders', 'x-inst-orders'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication({ adapter: node() }).mount(pets, orders)

    await app.bootstrap()

    const petsRes = await app.request('/inst-pets')
    const ordersRes = await app.request('/inst-orders')

    expect(petsRes.headers.get('x-inst')).toBe('yes')
    expect(petsRes.headers.get('x-inst-orders')).toBeNull()
    expect(ordersRes.headers.get('x-inst-orders')).toBe('yes')
    expect(ordersRes.headers.get('x-inst')).toBeNull()
  })
})

describe('a plugin factory typed against the application configuration', () => {
  // Mounting a router gives the application its route types back, which a bare `WebApplication` cannot hold.
  let app: WebApplication<any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The one test that has to keep compiling: a plugin configurer and a bare factory both take their `config`
  // type from the application, so if `C` ever regresses, `config.health` and `config.security` stop
  // type-checking and `npm run test:typecheck` fails.
  it('types both a plugin configurer and a bare factory against the application configuration', async () => {
    const schema = $t.Object({
      security: $t.Object({ header: $t.String() }),
      health: $t.Object({ enabled: $t.Optional($t.Boolean()) }),
    })
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ security: { header: 'x-from-config' } }))
      .build().config

    const pets = new Router('/typed').get('/', () => ({ ok: true }))

    app = createWebApplication({ adapter: node(), config: conf })
      .with(healthProbes((h, { config }) => h.config(config.health)))
      .with(({ config }) => new Marking(config.security.header))
      .mount(pets)

    await app.bootstrap()

    expect((await app.request('/typed')).headers.get('x-from-config')).toBe('yes')
    // Mounted rather than absent, so the feature really installed. What it then reports is health's own test.
    expect((await app.request('/readyz')).status).not.toBe(404)
  })
})
