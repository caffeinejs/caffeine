import { CaffeineIoC, token } from '@caffeinejs/di'
import { kFeatureConfigure, kFeatureName, newConfiguration, type Feature } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { newNoopLogger, type Logger } from '@caffeinejs/std/logger'
import { $t } from '@caffeinejs/std/schema'
import { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from '../adapter.js'
import { Controller, Get, Use } from '../decorators/index.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { createWebApplication, type WebApplication, healthProbes } from '../index.js'
import type { HTTPPluginFactory } from '../plugin.js'
import { newRouter } from '../routing/programmatic/new_router.js'
import { Router } from '../routing/programmatic/router.js'

/**
 * What an application installs on its server: the plugins its `.with(...)` factories produce.
 *
 * These tests pin the ordering model — the order `.with(...)` was written, whatever a factory awaits, with
 * nothing sorted by what a plugin is — the slots the framework keeps at both ends, that an `.install(...)`
 * never takes a slot at all, and a plugin belonging to one route group instead of the whole server.
 */

/**
 * One `fastify-plugin`-wrapped plugin that stamps a response header.
 *
 * Wrapped, so the hook lands on whatever context the plugin was registered in — the root server when the
 * application registered it, one route group when a router or a controller did.
 */
function stamping(name: string, header: string, log?: string[]): HTTPPluginFactory {
  return () => {
    const plugin: FastifyPluginAsync = async instance => {
      log?.push(name)
      instance.addHook('onRequest', (_request, reply, done) => {
        reply.header(header, 'yes')
        done()
      })
    }

    return fp(plugin, { name })
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
    const reading: HTTPPluginFactory = ({ container }) => {
      const value = container.get(kGreeting)
      const plugin: FastifyPluginAsync = async instance => {
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header('x-greeting', value)
          done()
        })
      }

      return fp(plugin, { name: 'greeting-reader' })
    }

    const before = createWebApplication().install(greeting()).with(reading)
    const after = createWebApplication().with(reading).install(greeting())

    try {
      await before.bootstrap()
      await after.bootstrap()

      expect((await before.fetch('/nothing-here')).headers.get('x-greeting')).toBe('hello')
      expect((await after.fetch('/nothing-here')).headers.get('x-greeting')).toBe('hello')
    } finally {
      await before.close()
      await after.close()
    }
  })

  // The decoration a dependent plugin fails loudly with: it answers for user installs and for the framework's
  // own built-ins alike, since their names enter the same set.
  it('answers $hasFeature on the instance for installed features and built-ins', async () => {
    const idle: Feature = {
      [kFeatureName]: 'idle',
      [kFeatureConfigure](): void {
        // Nothing to bind.
      },
    }

    app = createWebApplication().install(idle)

    await app.bootstrap()

    expect(app.instance.$hasFeature('idle')).toBe(true)
    expect(app.instance.$hasFeature('cookie')).toBe(true)
    expect(app.instance.$hasFeature('error-handling')).toBe(true)
    expect(app.instance.$hasFeature('shutdown')).toBe(true)
    expect(app.instance.$hasFeature('nope')).toBe(false)
  })

  // A factory runs before the server exists, so the same answer sits on its context.
  it('answers hasFeature on the setup context handed to factories', async () => {
    let seen: boolean[] = []

    app = createWebApplication().with(context => {
      seen = [context.hasFeature('cookie'), context.hasFeature('nope')]
      return fp(async () => undefined, { name: 'has-feature-probe' })
    })

    await app.bootstrap()

    expect(seen).toEqual([true, false])
  })

  // The plugin body loads in its slot, which is what makes a forgotten `await` harmless: what it registered
  // loads as part of its slot, before the next one starts.
  it('loads what a plugin registered without awaiting before the next slot', async () => {
    const log: string[] = []

    const forgetful: HTTPPluginFactory = () => {
      const plugin = (instance: FastifyInstance, _opts: unknown, done: () => void): void => {
        void instance.register(
          fp(
            async () => {
              log.push('nested')
            },
            { name: 'nested' },
          ),
        )
        done()
      }

      return fp(plugin, { name: 'forgetful' })
    }

    app = createWebApplication()
      .with(forgetful)
      .with(stamping('after', 'x-after', log))

    await app.bootstrap()

    expect(log).toEqual(['nested', 'after'])
  })

  // The plugin body runs on the application's own server, with what the framework decorates already there.
  it('hands a plugin the application server, already decorated', async () => {
    let decorated = false

    const probe: HTTPPluginFactory = () =>
      fp(
        async (instance: FastifyInstance) => {
          decorated = instance.hasDecorator('$container')
        },
        { name: 'decoration-probe' },
      )

    app = createWebApplication().with(probe)

    await app.bootstrap()

    expect(decorated).toBe(true)
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
        return fp(async () => undefined, { name: 'context-probe' })
      })
      .with(context => {
        seen.second = context
        return fp(async () => undefined, { name: 'context-probe-2' })
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

    const factory: HTTPPluginFactory = ({ container }) => {
      const greeting = container.get(kGreeting)

      const plugin: FastifyPluginAsync = async instance => {
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header('x-greeting', greeting)
          done()
        })
      }

      return fp(plugin, { name: 'greeting' })
    }

    app = createWebApplication({ container }).with(factory)

    await expect(app.bootstrap()).resolves.not.toThrow()

    expect((await app.fetch('/nothing-here')).headers.get('x-greeting')).toBe('hello')
  })

  // The order a plugin ends up in is the order its `.with(...)` was written — not the order its factory happens to
  // finish resolving. An awaiting factory must not jump ahead of, or fall behind, a synchronous one written before
  // or after it.
  it('keeps an awaiting app-level factory at its written position', async () => {
    const log: string[] = []

    const awaiting: HTTPPluginFactory = async () => {
      await new Promise(resolve => setTimeout(resolve, 10))

      const plugin: FastifyPluginAsync = async instance => {
        log.push('awaiting')
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header('x-awaiting', 'yes')
          done()
        })
      }

      return fp(plugin, { name: 'awaiting' })
    }

    app = createWebApplication()
      .with(stamping('before', 'x-before', log))
      .with(awaiting)
      .with(stamping('after', 'x-after', log))

    await app.bootstrap()

    expect(log).toEqual(['before', 'awaiting', 'after'])
  })

  // The head slot: error handling is installed ahead of everything the application installed, so a route that
  // throws is answered by the framework handler rather than by Fastify's default.
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

    const res = await app.fetch('/head-slot/boom')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-stamp')).toBe('yes')
    expect(await res.json()).toMatchObject({ message: 'nope' })
  })

  // The tail slot: the not-found handler is contributed last, so it sees whatever the plugins decorated the
  // server with and still answers a URL no route matched.
  it('answers an unmatched URL from the not-found handler registered after every plugin', async () => {
    app = createWebApplication().with(stamping('stamp', 'x-stamp'))

    await app.bootstrap()

    const res = await app.fetch('/nothing-here')

    expect(res.status).toBe(404)
    expect(res.headers.get('x-stamp')).toBe('yes')
  })
})

describe('scoped plugin registration', () => {
  // Widened: `mount()` re-types the application with the routes it took, and the holder outlives the call.
  let app: WebApplication<any, any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The capability the extension mechanism did not have. A route group is its own Fastify plugin context, so
  // the same wrapped plugin covers that group's routes and no others when it is registered there.
  it('keeps a router-installed plugin inside that router', async () => {
    const pets = newRouter('/scoped-pets')
      .plugin(stamping('pets-stamp', 'x-pets'))
      .get('/', () => ({ ok: true }))

    // Bound to no adapter, and mounted next to a Fastify-bound router all the same.
    const orders = new Router('/scoped-orders').get('/', () => ({ ok: true }))

    app = createWebApplication().mount(pets, orders)

    await app.bootstrap()

    expect((await app.fetch('/scoped-pets')).headers.get('x-pets')).toBe('yes')
    expect((await app.fetch('/scoped-orders')).headers.get('x-pets')).toBeNull()
  })

  // A nested group is flattened into its own context, so inheritance is carried rather than encapsulated —
  // `.plugin(...)` reaches the groups below it the way `.with(...)` configuration does.
  it('reaches a nested group from the router that installed the plugin', async () => {
    const shop = newRouter('/scoped-shop')
      .plugin(stamping('shop-stamp', 'x-shop'))
      .get('/', () => ({ ok: true }))

    shop.group('/items', items => items.get('/', () => ({ ok: true })))

    app = createWebApplication().mount(shop)

    await app.bootstrap()

    expect((await app.fetch('/scoped-shop')).headers.get('x-shop')).toBe('yes')
    expect((await app.fetch('/scoped-shop/items')).headers.get('x-shop')).toBe('yes')
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

    expect((await app.fetch('/scoped-admin')).headers.get('x-admin')).toBe('yes')
    expect((await app.fetch('/scoped-public')).headers.get('x-admin')).toBeNull()
  })

  // A plugin has no name a caller chose, so registering the same factory twice registers the plugin twice —
  // nothing dedupes on the factory's identity the way a feature dedupes on `kFeatureName`. Deliberately not
  // `fastify-plugin`-wrapped: with no name, there is nothing for the guard below to collide on.
  it('registers an unnamed plugin once per call, even for the same factory', async () => {
    const log: string[] = []
    const twice: HTTPPluginFactory = () => {
      const plugin: FastifyPluginAsync = async () => {
        log.push('twice')
      }
      return plugin
    }

    app = createWebApplication().with(twice).with(twice)

    await app.bootstrap()

    expect(log).toEqual(['twice', 'twice'])
  })

  // A first-party plugin wraps a fixed `fastify-plugin` name, so two `.with()` calls that each produce one
  // would otherwise fail deep inside whatever it decorates — tens of seconds later, once avvio's own boot
  // timeout gives up waiting on it. Refused immediately instead, with a Caffeine error naming the plugin.
  it('refuses a second plugin registered under the same fastify-plugin name', async () => {
    const twice = stamping('twice', 'x-twice')

    app = createWebApplication().with(twice).with(twice)

    await expect(app.bootstrap()).rejects.toThrow(/Cannot register plugin "twice": it is already registered/)
  })

  // What a factory produced is only checked by the adapter, at start-up: a factory handing back the options
  // object instead of the plugin fails there, naming the problem, rather than inside Fastify.
  it('refuses an application factory that produced something other than a plugin', async () => {
    // Cast: the factory's result is deliberately not a Fastify extension.
    app = createWebApplication().with((() => ({ origin: '*' })) as never)

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_HTTP_INVALID_PLUGIN',
      message: expect.stringMatching(/expected a Fastify plugin, got object/),
    })
  })

  // A group installs its plugins through the same checks as the root server. A controller's `@Use(...)` takes
  // this path too, and never meets the application's type, so this check is all that stands in its way.
  it('refuses a router factory that produced something other than a plugin', async () => {
    // Cast: the factory's result is deliberately not a Fastify extension.
    const bad = newRouter('/bad-plugin')
      .plugin((() => ({ origin: '*' })) as never)
      .get('/', () => ({ ok: true }))

    app = createWebApplication().mount(bad)

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_HTTP_INVALID_PLUGIN',
      message: expect.stringMatching(/expected a Fastify plugin, got object/),
    })
  })

  it('refuses a second plugin a router installs under the same fastify-plugin name', async () => {
    const twice = newRouter('/twice-group')
      .plugin(stamping('twice-group', 'x-twice'))
      .plugin(stamping('twice-group', 'x-twice'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication().mount(twice)

    await expect(app.bootstrap()).rejects.toThrow(/Cannot register plugin "twice-group": it is already registered/)
  })

  it('keeps the plugins of two routers apart, one per group', async () => {
    const pets = newRouter('/inst-pets')
      .plugin(stamping('inst', 'x-inst'))
      .get('/', () => ({ ok: true }))
    const orders = newRouter('/inst-orders')
      .plugin(stamping('inst-orders', 'x-inst-orders'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication().mount(pets, orders)

    await app.bootstrap()

    const petsRes = await app.fetch('/inst-pets')
    const ordersRes = await app.fetch('/inst-orders')

    expect(petsRes.headers.get('x-inst')).toBe('yes')
    expect(petsRes.headers.get('x-inst-orders')).toBeNull()
    expect(ordersRes.headers.get('x-inst-orders')).toBe('yes')
    expect(ordersRes.headers.get('x-inst')).toBeNull()
  })
})

/**
 * A plugin taking options, as a third-party one does: the header it stamps is named by what it was registered
 * with rather than by what it closed over.
 */
function configurable(name: string): FastifyPluginAsync<{ header: string }> {
  return async (instance, options) => {
    instance.addHook('onRequest', (_request, reply, done) => {
      reply.header(options.header, 'yes')
      done()
    })
  }
}

/**
 * A factory handing back a plugin together with the options to register it with.
 *
 * This is what removes the wrapper an application would otherwise write only to close over the options — and
 * with it the `fastify-plugin` that wrapper needed. `@fastify/cors` and every other official plugin already
 * wraps itself, so registering one directly is what puts its hooks on every route.
 */
describe('a plugin registered with its options', () => {
  // Mounting a router gives the application its route types back, which a bare `WebApplication` cannot hold.
  let app: WebApplication<any, any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('hands the options the factory built to the plugin', async () => {
    const seen: string[] = []
    const recording: FastifyPluginAsync<{ header: string }> = async (_instance, options) => {
      seen.push(options.header)
    }

    app = createWebApplication().with(() => [fp(recording, { name: 'recording' }), { header: 'x-from-options' }])

    await app.bootstrap()

    expect(seen).toEqual(['x-from-options'])
  })

  // The reason the pair form exists. A wrapper written to carry the options is itself unwrapped, so it takes an
  // encapsulation context of its own; the plugin inside it lands there, and the route groups — registered on the
  // root, as siblings of that context — never see its hooks. Registering the plugin itself keeps its own
  // `fastify-plugin` doing the job it was wrapped for.
  it('covers a compiled route, with no wrapper left to encapsulate it', async () => {
    const pets = newRouter('/pair-pets').get('/', () => ({ ok: true }))

    app = createWebApplication()
      .with(() => [fp(configurable('pair'), { name: 'pair' }), { header: 'x-pair' }])
      .mount(pets)

    await app.bootstrap()

    expect((await app.fetch('/pair-pets')).headers.get('x-pair')).toBe('yes')
  })

  // Encapsulation stays the plugin author's call: the pair form changes where the options come from, never
  // whether the plugin is wrapped. An unwrapped one keeps its hooks to itself exactly as it does alone.
  it('leaves an unwrapped plugin covering nothing', async () => {
    const pets = newRouter('/pair-unwrapped').get('/', () => ({ ok: true }))

    app = createWebApplication()
      .with(() => [configurable('loose'), { header: 'x-loose' }])
      .mount(pets)

    await app.bootstrap()

    expect((await app.fetch('/pair-unwrapped')).headers.get('x-loose')).toBeNull()
  })

  it('reaches only its own group when a router installed the pair', async () => {
    const pets = newRouter('/pair-scoped-pets')
      .plugin(() => [fp(configurable('scoped'), { name: 'scoped' }), { header: 'x-scoped' }])
      .get('/', () => ({ ok: true }))
    const orders = newRouter('/pair-scoped-orders').get('/', () => ({ ok: true }))

    app = createWebApplication().mount(pets, orders)

    await app.bootstrap()

    expect((await app.fetch('/pair-scoped-pets')).headers.get('x-scoped')).toBe('yes')
    expect((await app.fetch('/pair-scoped-orders')).headers.get('x-scoped')).toBeNull()
  })

  // The one test that has to keep compiling: a plugin configurer and a bare factory returning a pair both take
  // their `config` type from the application, so if `C` ever regresses, `config.health` and `config.security`
  // stop type-checking and `npm run test:typecheck` fails.
  it('types both a plugin configurer and a pair against the application configuration', async () => {
    const schema = $t.Object({
      security: $t.Object({ header: $t.String() }),
      health: $t.Object({ enabled: $t.Optional($t.Boolean()) }),
    })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ security: { header: 'x-from-config' } }))
      .build()

    const pets = newRouter('/pair-typed').get('/', () => ({ ok: true }))

    app = createWebApplication({ config: conf })
      .with(healthProbes((h, { config }) => h.config(config.health)))
      .with(({ config }) => [fp(configurable('typed'), { name: 'typed' }), { header: config.security.header }])
      .mount(pets)

    await app.bootstrap()

    expect((await app.fetch('/pair-typed')).headers.get('x-from-config')).toBe('yes')
    // Mounted rather than absent, so the feature really installed. What it then reports is health's own test.
    expect((await app.fetch('/readyz')).status).not.toBe(404)
  })
})
