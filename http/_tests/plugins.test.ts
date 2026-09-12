import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'
import fastify from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { Controller, Get, Use } from '../decorators/index.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { createWebApplication, fastifyAdapterFactory, type WebApplication } from '../index.js'
import { registerPlugin, type HTTPPlugin, type HTTPPluginFactory, type HTTPPluginProvider } from '../plugin.js'
import { Router } from '../routing/programmatic/router.js'

/**
 * What replaced `ServerExtension`: a feature's bootstrap hands the application an ordinary Fastify plugin.
 *
 * These tests pin the three things the old mechanism did with bands and a registry, and the one it could not
 * do at all. Order is the order `.plugin(...)` was written — nothing sorts by what a plugin is. The framework
 * still brackets the list at both ends. And a plugin can now belong to one route group instead of the whole
 * server, which is what having a real Fastify plugin buys.
 */

/**
 * One `fastify-plugin`-wrapped plugin that stamps a response header.
 *
 * Wrapped, so the hook lands on whatever context the plugin was registered in — the root server when the
 * application registered it, one route group when a router or a controller did.
 */
function stamping(name: string, header: string, log?: string[]): HTTPPluginFactory {
  return () => {
    const plugin: HTTPPlugin = async instance => {
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
  it('registers plugins in the order .plugin() was written', async () => {
    const log: string[] = []

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(stamping('third', 'x-third', log))
      .plugin(stamping('first', 'x-first', log))
      .plugin(stamping('second', 'x-second', log))
      .build()

    await app.ready()

    expect(log).toEqual(['third', 'first', 'second'])
  })

  // `.plugin` takes a factory; `.extend` takes a feature. Both land in one list, so what matters is that
  // neither kind jumps the other: the order is the order the calls were written.
  it('interleaves features and plugins in the order they were written', async () => {
    const log: string[] = []

    const feature = (name: string): Feature => ({
      [kFeatureName]: name,
      [kBootstrap](kit: BootstrapKit): void {
        registerPlugin(
          kit,
          fp(
            async () => {
              log.push(name)
            },
            { name },
          ),
        )
      },
    })

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(stamping('plugin-a', 'x-a', log))
      .extend(feature('feature-b'))
      .plugin(stamping('plugin-c', 'x-c', log))
      .extend(feature('feature-d'))
      .build()

    await app.ready()

    expect(log).toEqual(['plugin-a', 'feature-b', 'plugin-c', 'feature-d'])
  })

  // An app-level factory is called from `WebApplication.setup()`, after `container.init()` — not from its
  // feature's bootstrap, where the container has not initialized yet and this would throw
  // `ErrInvalidContainerState`. Resolving here, inside the factory itself rather than inside the plugin body,
  // is exactly the case that used to be broken.
  it('resolves from the container inside an app-level factory', async () => {
    const kGreeting = token<string>(Symbol('greeting'))
    const container = new CaffeineIoC()
    container.bind(kGreeting, t => t.toValue('hello'))

    const factory: HTTPPluginFactory = (_config, container) => {
      const greeting = container.get(kGreeting)

      const plugin: HTTPPlugin = async instance => {
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header('x-greeting', greeting)
          done()
        })
      }

      return fp(plugin, { name: 'greeting' })
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .plugin(factory)
      .build()

    await expect(app.ready()).resolves.not.toThrow()

    expect((await app.fetch('/nothing-here')).headers.get('x-greeting')).toBe('hello')
  })

  // The order a plugin ends up in is the order its `.plugin(...)` was written, stamped when its feature
  // bootstrapped — not the order its factory happens to finish resolving. An awaiting factory must not jump
  // ahead of, or fall behind, a synchronous one written before or after it.
  it('keeps an awaiting app-level factory at its written position', async () => {
    const log: string[] = []

    const deferred: HTTPPluginFactory = async () => {
      await new Promise(resolve => setTimeout(resolve, 10))

      const plugin: HTTPPlugin = async instance => {
        log.push('deferred')
        instance.addHook('onRequest', (_request, reply, done) => {
          reply.header('x-deferred', 'yes')
          done()
        })
      }

      return fp(plugin, { name: 'deferred' })
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(stamping('before', 'x-before', log))
      .plugin(deferred)
      .plugin(stamping('after', 'x-after', log))
      .build()

    await app.ready()

    expect(log).toEqual(['before', 'deferred', 'after'])
  })

  // The head slot: error handling is bootstrapped ahead of everything the application installed, so a route
  // that throws is answered by the framework handler rather than by Fastify's default.
  it('covers a route with the framework error handler whatever a plugin registered', async () => {
    @Controller('/head-slot')
    class HeadSlotController {
      @Get('/boom')
      boom(): never {
        throw new ErrHTTPBadRequest('nope')
      }
    }
    void [HeadSlotController]

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(stamping('stamp', 'x-stamp'))
      .build()

    await app.ready()

    const res = await app.fetch('/head-slot/boom')

    expect(res.status).toBe(400)
    expect(res.headers.get('x-stamp')).toBe('yes')
    expect(await res.json()).toMatchObject({ message: 'nope' })
  })

  // The tail slot: the not-found handler is contributed last, so it sees whatever the plugins decorated the
  // server with and still answers a URL no route matched.
  it('answers an unmatched URL from the not-found handler registered after every plugin', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(stamping('stamp', 'x-stamp'))
      .build()

    await app.ready()

    const res = await app.fetch('/nothing-here')

    expect(res.status).toBe(404)
    expect(res.headers.get('x-stamp')).toBe('yes')
  })
})

describe('scoped plugin registration', () => {
  // Widened: `mount()` re-types the application with the routes it took, and the holder outlives the call.
  let app: WebApplication<any, any, any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The capability the extension mechanism did not have. A route group is its own Fastify plugin context, so
  // the same wrapped plugin covers that group's routes and no others when it is registered there.
  it('keeps a router-installed plugin inside that router', async () => {
    const pets = new Router('/scoped-pets').plugin(stamping('pets-stamp', 'x-pets')).get('/', () => ({ ok: true }))

    const orders = new Router('/scoped-orders').get('/', () => ({ ok: true }))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .build()
      .mount(pets, orders)

    await app.ready()

    expect((await app.fetch('/scoped-pets')).headers.get('x-pets')).toBe('yes')
    expect((await app.fetch('/scoped-orders')).headers.get('x-pets')).toBeNull()
  })

  // A nested group is flattened into its own context, so inheritance is carried rather than encapsulated —
  // `.plugin(...)` reaches the groups below it the way `.with(...)` configuration does.
  it('reaches a nested group from the router that installed the plugin', async () => {
    const shop = new Router('/scoped-shop').plugin(stamping('shop-stamp', 'x-shop')).get('/', () => ({ ok: true }))

    shop.group('/items', items => items.get('/', () => ({ ok: true })))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .build()
      .mount(shop)

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

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false }))).build()

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
      const plugin: HTTPPlugin = async () => {
        log.push('twice')
      }
      return plugin
    }

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(twice)
      .plugin(twice)
      .build()

    await app.ready()

    expect(log).toEqual(['twice', 'twice'])
  })

  // A first-party plugin wraps a fixed `fastify-plugin` name, so two `.plugin()` calls that each produce one
  // would otherwise fail deep inside whatever it decorates — tens of seconds later, once avvio's own boot
  // timeout gives up waiting on it. Refused immediately instead, with a Caffeine error naming the plugin.
  it('refuses a second plugin registered under the same fastify-plugin name', async () => {
    const twice = stamping('twice', 'x-twice')

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(twice)
      .plugin(twice)
      .build()

    await expect(app.ready()).rejects.toThrow(/Cannot register plugin "twice": it is already registered/)
  })

  it('keeps the plugins of two routers apart, one per group', async () => {
    const pets = new Router('/inst-pets').plugin(stamping('inst', 'x-inst')).get('/', () => ({ ok: true }))
    const orders = new Router('/inst-orders')
      .plugin(stamping('inst-orders', 'x-inst-orders'))
      .get('/', () => ({ ok: true }))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .build()
      .mount(pets, orders)

    await app.ready()

    const petsRes = await app.fetch('/inst-pets')
    const ordersRes = await app.fetch('/inst-orders')

    expect(petsRes.headers.get('x-inst')).toBe('yes')
    expect(petsRes.headers.get('x-inst-orders')).toBeNull()
    expect(ordersRes.headers.get('x-inst-orders')).toBe('yes')
    expect(ordersRes.headers.get('x-inst')).toBeNull()
  })
})

function tokenStamp(name: string, header: string): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    instance.addHook('onRequest', (_request, reply, done) => {
      reply.header(header, 'yes')
      done()
    })
  }

  return fp(plugin, { name })
}

describe('plugin provider tokens', () => {
  let app: WebApplication<any, any, any, any, any> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('registers a plugin from a class token', async () => {
    class ClassStamp implements HTTPPluginProvider {
      create() {
        return tokenStamp('class-stamp', 'x-class')
      }
    }

    const container = new CaffeineIoC()
    container.bind(ClassStamp, t => t.toSelf())

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .plugin(ClassStamp)
      .build()

    await app.ready()

    expect((await app.fetch('/nothing-here')).headers.get('x-class')).toBe('yes')
  })

  it('registers a plugin from a named token bound to a provider class', async () => {
    class NamedStamp implements HTTPPluginProvider {
      create() {
        return tokenStamp('named-stamp', 'x-named')
      }
    }

    const kStamp = token<HTTPPluginProvider>(Symbol('named-stamp'))
    const container = new CaffeineIoC()
    container.bind(kStamp, t => t.toClass(NamedStamp))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .plugin(kStamp)
      .build()

    await app.ready()

    expect((await app.fetch('/nothing-here')).headers.get('x-named')).toBe('yes')
  })

  it('throws at ready() when the token is not bound', async () => {
    const kMissing = token<HTTPPluginProvider>(Symbol('missing-plugin'))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .plugin(kMissing)
      .build()

    await expect(app.ready()).rejects.toThrow(/Cannot resolve key/)
  })

  it('throws when the resolved value has no create method', async () => {
    const kBad = token<HTTPPluginProvider>(Symbol('not-a-provider'))
    const container = new CaffeineIoC()
    container.bind(kBad, t => t.toValue({ ok: true } as never))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .plugin(kBad)
      .build()

    await expect(app.ready()).rejects.toThrow(/has no "create" method/)
  })

  it('refuses a request-scoped provider', async () => {
    class RequestStamp implements HTTPPluginProvider {
      create() {
        return tokenStamp('request-stamp', 'x-request')
      }
    }

    const container = new CaffeineIoC()
    container.bind(RequestStamp, t => t.toSelf().lifetime(Scopes.REQUEST))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .plugin(RequestStamp)
      .build()

    await expect(app.ready()).rejects.toThrow(/request scope/)
  })

  it('keeps a router-installed provider token inside that router', async () => {
    class PetsStamp implements HTTPPluginProvider {
      create() {
        return tokenStamp('router-token-stamp', 'x-router-token')
      }
    }

    const container = new CaffeineIoC()
    container.bind(PetsStamp, t => t.toSelf())

    const pets = new Router('/token-pets').plugin(PetsStamp).get('/', () => ({ ok: true }))
    const orders = new Router('/token-orders').get('/', () => ({ ok: true }))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container })
      .build()
      .mount(pets, orders)

    await app.ready()

    expect((await app.fetch('/token-pets')).headers.get('x-router-token')).toBe('yes')
    expect((await app.fetch('/token-orders')).headers.get('x-router-token')).toBeNull()
  })

  it('keeps a controller-installed provider token inside that controller', async () => {
    class AdminStamp implements HTTPPluginProvider {
      create() {
        return tokenStamp('use-token-stamp', 'x-use-token')
      }
    }

    @Use(AdminStamp)
    @Controller('/token-admin')
    class AdminController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }

    @Controller('/token-public')
    class PublicController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [AdminController, PublicController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
    builder.container.bind(AdminStamp, t => t.toSelf())
    app = builder.build()

    await app.ready()

    expect((await app.fetch('/token-admin')).headers.get('x-use-token')).toBe('yes')
    expect((await app.fetch('/token-public')).headers.get('x-use-token')).toBeNull()
  })
})
