import { CaffeineIoC, token } from '@caffeinejs/di'
import { kFeatureConfigure, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { newNoopLogger, type Logger } from '@caffeinejs/std/logger'
import fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { Controller, Get, Use } from '../decorators/index.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { kFeatureServer, type HTTPFeature } from '../feature.js'
import { createWebApplication, fastifyAdapterFactory, type WebApplication } from '../index.js'
import type { HTTPPluginFactory } from '../plugin.js'
import { newRouter } from '../routing/programmatic/new_router.js'
import { Router } from '../routing/programmatic/router.js'
import type { HTTPSetupContext } from '../setup_context.js'

/**
 * What an application installs on its server: the plugins its factories produce and its features' server hooks.
 *
 * These tests pin the ordering model — the order `.with(...)` was written, whatever a factory or a hook awaits, with
 * nothing sorted by what a plugin is — the slots the framework keeps at both ends, what a server hook is handed,
 * and a plugin belonging to one route group instead of the whole server.
 */

/** A feature whose server hook registers one named plugin that records when it loaded. */
function logging(name: string, log: string[]): HTTPFeature {
  return {
    [kFeatureName]: name,
    [kFeatureConfigure](): void {
      // Nothing to bind.
    },
    [kFeatureServer]: async (instance: FastifyInstance): Promise<void> => {
      await instance.register(
        fp(
          async () => {
            log.push(name)
          },
          { name },
        ),
      )
    },
  }
}

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(stamping('third', 'x-third', log))
      .with(stamping('first', 'x-first', log))
      .with(stamping('second', 'x-second', log))

    await app.ready()

    expect(log).toEqual(['third', 'first', 'second'])
  })

  // `.with` takes a factory or a feature. Both land in one list, so what matters is that neither kind jumps
  // the other: the order is the order the calls were written.
  it('interleaves features and plugins in the order they were written', async () => {
    const log: string[] = []

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(stamping('plugin-a', 'x-a', log))
      .with(logging('feature-b', log))
      .with(stamping('plugin-c', 'x-c', log))
      .with(logging('feature-d', log))

    await app.ready()

    expect(log).toEqual(['plugin-a', 'feature-b', 'plugin-c', 'feature-d'])
  })

  // `addFeature` skips the name check `.with(...)` makes, and nothing else: a feature installed through it still
  // wires the server, in the slot it was installed in.
  it('runs the server hook of a feature installed with addFeature, in its slot', async () => {
    const log: string[] = []

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(stamping('before', 'x-before', log))
      .addFeature(logging('added', log))
      .with(stamping('after', 'x-after', log))

    await app.ready()

    expect(log).toEqual(['before', 'added', 'after'])
  })

  // The authentication gate relies on this: a feature's slot is where it was written, so a hook that awaits
  // before it registers anything cannot let a feature written after it register first.
  it('keeps a server hook that awaits first at its written position', async () => {
    const log: string[] = []

    const slow: HTTPFeature = {
      [kFeatureName]: 'slow',
      [kFeatureConfigure](): void {
        // Nothing to bind.
      },
      [kFeatureServer]: async (instance: FastifyInstance): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, 10))
        await instance.register(
          fp(
            async () => {
              log.push('slow')
            },
            { name: 'slow' },
          ),
        )
      },
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(slow)
      .with(stamping('after', 'x-after', log))

    await app.ready()

    expect(log).toEqual(['slow', 'after'])
  })

  // The hook body is a plugin body, which is what makes a forgotten `await` harmless: what it registered loads as
  // part of its slot, before the next one starts.
  it('loads what a server hook registered without awaiting before the next slot', async () => {
    const log: string[] = []

    const forgetful: HTTPFeature = {
      [kFeatureName]: 'forgetful',
      [kFeatureConfigure](): void {
        // Nothing to bind.
      },
      [kFeatureServer]: (instance: FastifyInstance): void => {
        void instance.register(
          fp(
            async () => {
              log.push('nested')
            },
            { name: 'nested' },
          ),
        )
      },
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(forgetful)
      .with(stamping('after', 'x-after', log))

    await app.ready()

    expect(log).toEqual(['nested', 'after'])
  })

  // Why the server was not simply put on the bootstrap kit: bootstrap runs before the adapter has set the server up.
  // The hook runs where plugins run, on the application's own server, with what the framework decorates already
  // there.
  it('hands a server hook the application server, already decorated', async () => {
    let seen: FastifyInstance | undefined
    let decorated = false

    const probe: HTTPFeature = {
      [kFeatureName]: 'probe',
      [kFeatureConfigure](): void {
        // Nothing to bind.
      },
      [kFeatureServer]: (instance: FastifyInstance): void => {
        seen = instance
        decorated = instance.hasDecorator('$container')
      },
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).with(probe)

    await app.ready()

    expect(seen).toBe(app.instance)
    expect(decorated).toBe(true)
  })

  // The logger feature configures alongside every other feature, so the logger is only final once they all have.
  // What the factories and hooks are handed is built after that, which is why it carries the one `.logger(...)`
  // asked for rather than the default the application started with.
  it('hands factories and server hooks one context carrying the configured logger', async () => {
    const custom: Logger = { ...newNoopLogger() }
    const seen: { factory?: HTTPSetupContext; hook?: BootstrapKit } = {}

    const probe: HTTPFeature = {
      [kFeatureName]: 'kit-probe',
      [kFeatureConfigure](): void {
        // Nothing to bind.
      },
      [kFeatureServer]: (_instance: FastifyInstance, kit: BootstrapKit): void => {
        seen.hook = kit
      },
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .logger(b => b.use(custom))
      .with(context => {
        seen.factory = context
        return fp(async () => undefined, { name: 'context-probe' })
      })
      .with(probe)

    await app.ready()

    expect(seen.hook).toBe(seen.factory)
    expect(seen.factory?.logger).toBe(custom)
    expect(seen.factory?.container).toBe(app.container)
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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container }).with(factory)

    await expect(app.ready()).resolves.not.toThrow()

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(stamping('before', 'x-before', log))
      .with(awaiting)
      .with(stamping('after', 'x-after', log))

    await app.ready()

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).with(stamping('stamp', 'x-stamp'))

    await app.ready()

    const res = await app.fetch('/head-slot/boom')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-stamp')).toBe('yes')
    expect(await res.json()).toMatchObject({ message: 'nope' })
  })

  // The tail slot: the not-found handler is contributed last, so it sees whatever the plugins decorated the
  // server with and still answers a URL no route matched.
  it('answers an unmatched URL from the not-found handler registered after every plugin', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).with(stamping('stamp', 'x-stamp'))

    await app.ready()

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).mount(pets, orders)

    await app.ready()

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).mount(shop)

    await app.ready()

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))

    await app.ready()

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(twice)
      .with(twice)

    await app.ready()

    expect(log).toEqual(['twice', 'twice'])
  })

  // A first-party plugin wraps a fixed `fastify-plugin` name, so two `.with()` calls that each produce one
  // would otherwise fail deep inside whatever it decorates — tens of seconds later, once avvio's own boot
  // timeout gives up waiting on it. Refused immediately instead, with a Caffeine error naming the plugin.
  it('refuses a second plugin registered under the same fastify-plugin name', async () => {
    const twice = stamping('twice', 'x-twice')

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .with(twice)
      .with(twice)

    await expect(app.ready()).rejects.toThrow(/Cannot register plugin "twice": it is already registered/)
  })

  it('keeps the plugins of two routers apart, one per group', async () => {
    const pets = newRouter('/inst-pets')
      .plugin(stamping('inst', 'x-inst'))
      .get('/', () => ({ ok: true }))
    const orders = newRouter('/inst-orders')
      .plugin(stamping('inst-orders', 'x-inst-orders'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).mount(pets, orders)

    await app.ready()

    const petsRes = await app.fetch('/inst-pets')
    const ordersRes = await app.fetch('/inst-orders')

    expect(petsRes.headers.get('x-inst')).toBe('yes')
    expect(petsRes.headers.get('x-inst-orders')).toBeNull()
    expect(ordersRes.headers.get('x-inst-orders')).toBe('yes')
    expect(ordersRes.headers.get('x-inst')).toBeNull()
  })
})
