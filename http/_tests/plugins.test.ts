import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'
import fastify from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { Controller, Get, Use } from '../decorators/index.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { createWebApplication, fastifyAdapterFactory, type WebApplication } from '../index.js'
import { registerPlugin, type HTTPPlugin, type HTTPPluginFactory } from '../plugin.js'
import { Router } from '../routing/programmatic/router.js'

/**
 * What replaced `ServerExtension`: a feature's bootstrap hands the application an ordinary Fastify plugin.
 *
 * These tests pin the three things the old mechanism did with bands and a registry, and the one it could not
 * do at all. Order is the order `.extend(...)` was written — nothing sorts by what a plugin is. The framework
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
  it('registers plugins in the order .extend() was written', async () => {
    const log: string[] = []

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .extend(stamping('third', 'x-third', log))
      .extend(stamping('first', 'x-first', log))
      .extend(stamping('second', 'x-second', log))
      .build()

    await app.ready()

    expect(log).toEqual(['third', 'first', 'second'])
  })

  // `.extend` takes a feature or a plugin factory and tells them apart by `typeof`. Both land in one list, so
  // what matters is that neither kind jumps the other: the order is the order the calls were written.
  it('interleaves features and plugins in the order .extend() was written', async () => {
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
      .extend(stamping('plugin-a', 'x-a', log))
      .extend(feature('feature-b'))
      .extend(stamping('plugin-c', 'x-c', log))
      .extend(feature('feature-d'))
      .build()

    await app.ready()

    expect(log).toEqual(['plugin-a', 'feature-b', 'plugin-c', 'feature-d'])
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
      .extend(stamping('stamp', 'x-stamp'))
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
      .extend(stamping('stamp', 'x-stamp'))
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
    const pets = new Router('/scoped-pets').extend(stamping('pets-stamp', 'x-pets')).get('/', () => ({ ok: true }))

    const orders = new Router('/scoped-orders').get('/', () => ({ ok: true }))

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .build()
      .mount(pets, orders)

    await app.ready()

    expect((await app.fetch('/scoped-pets')).headers.get('x-pets')).toBe('yes')
    expect((await app.fetch('/scoped-orders')).headers.get('x-pets')).toBeNull()
  })

  // A nested group is flattened into its own context, so inheritance is carried rather than encapsulated —
  // `.extend(...)` reaches the groups below it the way `.with(...)` configuration does.
  it('reaches a nested group from the router that installed the plugin', async () => {
    const shop = new Router('/scoped-shop').extend(stamping('shop-stamp', 'x-shop')).get('/', () => ({ ok: true }))

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

  // A plugin has no name a caller chose, so it is never deduplicated: registering the same factory twice
  // registers the plugin twice, which is what asking for two of something means. Only features dedup.
  it('registers a plugin once per call, even for the same factory', async () => {
    const log: string[] = []
    const twice = stamping('twice', 'x-twice', log)

    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })))
      .extend(twice)
      .extend(twice)
      .build()

    await app.ready()

    expect(log).toEqual(['twice', 'twice'])
  })

  it('keeps the plugins of two routers apart, one per group', async () => {
    const pets = new Router('/inst-pets').extend(stamping('inst', 'x-inst')).get('/', () => ({ ok: true }))
    const orders = new Router('/inst-orders')
      .extend(stamping('inst-orders', 'x-inst-orders'))
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
