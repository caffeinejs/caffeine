import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import fastify, { type RouteOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { Cache, caching } from '../index.js'

/**
 * The caching feature reaches routes through the public `RouteContributor` seam, not through the adapter.
 * These tests pin that wiring: the contributor runs, decorates the request, and touches only the routes
 * that declared cache config.
 */
describe('CacheRouteContributor wiring', () => {
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

    const app = createWebApplication(fastifyAdapterFactory(server)).extend(caching()).build()
    close = () => app.close()
    await app.ready()

    // configure() ran: the request decoration is in place.
    expect(server.hasRequestDecorator('responseCached')).toBe(true)

    // onRoute() only touched the decorated route.
    expect(registered.get('GET /contrib/plain')!.onSend).toBeUndefined()
    expect(typeof registered.get('GET /contrib/cached')!.onSend).toBe('function')
  })
})
