import { kFeatureConfigure, kFeatureName, newConfiguration, type Feature } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { newNoopLogger, type Logger } from '@caffeinejs/application/logger'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC, token } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrHTTPBadRequest } from '../core/error/http.js'
import { healthProbes } from '../core/health/index.js'
import { Router } from '../core/routing/programmatic/programmatic.js'
import { Controller, Get, Use } from '../decorators/index.js'
import { HTTPPlugin, type WebApplication } from '../index.js'
import { createWebApplication } from '../platform/node/index.js'
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

      register({ app }: HTTPSetupContext): void {
        log?.push(name)
        app.hook('onRequest', ctx => void ctx.header(header, 'yes'))
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

  register({ app }: HTTPSetupContext): void {
    app.hook('onRequest', ctx => void ctx.header(this.#header, this.#value))
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

    app = createWebApplication()
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

    const before = createWebApplication().install(greeting()).with(reading)
    const after = createWebApplication().with(reading).install(greeting())

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

    app = createWebApplication().with(context => {
      seen = [context.hasFeature('cookie'), context.hasFeature('nope')]
      return new Marking('x-has-feature-probe')
    })

    await app.bootstrap()

    expect(seen).toEqual([true, false])
  })

  // The logger feature configures alongside every other feature, so the logger is only final once they all have.
  // What the factories are handed is built after that, which is why it carries the one `.logger(...)` asked for
  // rather than the default the application started with.
  it('hands every factory one context carrying the configured logger', async () => {
    const custom: Logger = { ...newNoopLogger() }
    const seen: { first?: HTTPSetupContext; second?: HTTPSetupContext } = {}

    app = createWebApplication()
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

    expect(seen.first).toBe(seen.second)
    expect(seen.first?.logger).toBe(custom)
    expect(seen.first?.container).toBe(app.container)
  })

  // An app-level factory is called once the container has initialized — not while features configure, where
  // this would throw `ErrInvalidContainerState`. Resolving here, inside the factory itself rather than inside the
  // plugin body, is exactly the case that used to be broken.
  it('resolves from the container inside an app-level factory', async () => {
    const kGreeting = token<string>(Symbol('greeting'))
    const container = new CaffeineIoC()
    container.bind(kGreeting, t => t.toValue('hello'))

    const factory = ({ container }: HTTPSetupContext) => new Marking('x-greeting', container.get(kGreeting))

    app = createWebApplication({ container }).with(factory)

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

    app = createWebApplication()
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

    app = createWebApplication().with(stamping('stamp', 'x-stamp'))

    await app.bootstrap()

    const res = await app.request('/head-slot/boom')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-stamp')).toBe('yes')
    expect(await res.json()).toMatchObject({ detail: 'nope' })
  })

  // The tail slot: the not-found answer is contributed last, so it sees whatever the plugins decorated the
  // server with and still answers a URL no route matched.
  it('answers an unmatched URL from the not-found handler registered after every plugin', async () => {
    app = createWebApplication().with(stamping('stamp', 'x-stamp'))

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

  // The capability the extension mechanism did not have. A route group has a plugin scope of its own, so
  // the same plugin covers that group's routes and no others when it is registered there.
  it('keeps a router-installed plugin inside that router', async () => {
    const pets = new Router('/scoped-pets').with(stamping('pets-stamp', 'x-pets')).get('/', () => ({ ok: true }))

    // Mounted next to a plugin-scoped router all the same.
    const orders = new Router('/scoped-orders').get('/', () => ({ ok: true }))

    app = createWebApplication().mount(pets, orders)

    await app.bootstrap()

    expect((await app.request('/scoped-pets')).headers.get('x-pets')).toBe('yes')
    expect((await app.request('/scoped-orders')).headers.get('x-pets')).toBeNull()
  })

  // A nested group is flattened into its own context, so inheritance is carried rather than encapsulated —
  // `router.with(...)` reaches the groups below it the way `router.extend(...)` configuration does.
  it('reaches a nested group from the router that installed the plugin', async () => {
    const shop = new Router('/scoped-shop').with(stamping('shop-stamp', 'x-shop')).get('/', () => ({ ok: true }))

    shop.group('/items', items => items.get('/', () => ({ ok: true })))

    app = createWebApplication().mount(shop)

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

    app = createWebApplication()

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

    app = createWebApplication()

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

    app = createWebApplication().with(twice).with(twice)

    await app.bootstrap()

    expect(log).toEqual(['twice', 'twice'])
  })

  it('refuses a second plugin a router installs under the same name', async () => {
    const twice = new Router('/twice-group')
      .with(stamping('twice-group', 'x-twice'))
      .with(stamping('twice-group', 'x-twice'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication().mount(twice)

    await expect(app.bootstrap()).rejects.toThrow(/Cannot register plugin "twice-group" twice on router/)
  })

  it('keeps the plugins of two routers apart, one per group', async () => {
    const pets = new Router('/inst-pets').with(stamping('inst', 'x-inst')).get('/', () => ({ ok: true }))
    const orders = new Router('/inst-orders')
      .with(stamping('inst-orders', 'x-inst-orders'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication().mount(pets, orders)

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

    app = createWebApplication({ config: conf })
      .with(healthProbes((h, { config }) => h.config(config.health)))
      .with(({ config }) => new Marking(config.security.header))
      .mount(pets)

    await app.bootstrap()

    expect((await app.request('/typed')).headers.get('x-from-config')).toBe('yes')
    // Mounted rather than absent, so the feature really installed. What it then reports is health's own test.
    expect((await app.request('/readyz')).status).not.toBe(404)
  })
})
