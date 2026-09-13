import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify, { type RouteOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { Cache, HTTPCaching } from '../index.js'

/**
 * The caching feature reaches routes through Fastify's own `onRoute` hook, not through the adapter. These
 * tests pin that wiring: the plugin registers, decorates the request, and touches only the routes that
 * declared cache config.
 */
describe('cache plugin wiring', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('decorates the request and attaches hooks only where cache config is present', async () => {
    const registered = new Map<string, RouteOptions>()

    @Controller('/contrib')
    class ContribController {
      @Get('/plain')
      plain() {
        return { ok: true }
      }

      @Cache({ ttl: 60 })
      @Get('/cached')
      cached() {
        return { ok: true }
      }
    }
    void [ContribController]

    const server = fastify()
    server.addHook('onRoute', route => {
      registered.set(`${route.method} ${route.url}`, route as RouteOptions)
    })

    const app = createWebApplication(fastifyAdapterFactory(server)).plugin(HTTPCaching()).build()
    close = () => app.close()
    await app.ready()

    // The plugin registered: the request decoration is in place.
    expect(server.hasRequestDecorator('responseCached')).toBe(true)

    // The onRoute hook only touched the decorated route.
    expect(registered.get('GET /contrib/plain')!.onSend).toBeUndefined()
    expect(typeof registered.get('GET /contrib/cached')!.onSend).toBe('function')
  })

  // The whole point of dropping the fixed `fastify-plugin` name: unlike a named first-party plugin,
  // HTTPCaching is never refused a second registration by `assertPluginNotRegistered`.
  it('registers more than once, each with its own settings, without ERR_HTTP_DUPLICATE_PLUGIN', async () => {
    @Controller('/contrib-multi')
    class MultiController {
      @Cache({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [MultiController]

    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server))
      .plugin(HTTPCaching(b => b.statusHeader('X-First')))
      .plugin(HTTPCaching(b => b.statusHeader('X-Second')))
      .build()
    close = () => app.close()

    await expect(app.ready()).resolves.toBeUndefined()

    const res = await app.fetch('/contrib-multi/data')
    // Both plugins' onRoute hooks attached to the same route independently — two hooks in each slot, each
    // writing its own status header.
    expect(res.headers.get('x-first')).toBe('MISS')
    expect(res.headers.get('x-second')).toBe('MISS')
  })
})
