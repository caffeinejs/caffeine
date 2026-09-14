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

    const app = createWebApplication(fastifyAdapterFactory(server)).with(HTTPCaching()).build()
    close = () => app.close()
    await app.ready()

    // The plugin registered: the request decoration is in place.
    expect(server.hasRequestDecorator('responseCached')).toBe(true)

    // The onRoute hook only touched the decorated route.
    expect(registered.get('GET /contrib/plain')!.onSend).toBeUndefined()
    expect(typeof registered.get('GET /contrib/cached')!.onSend).toBe('function')
  })

  // Named and fastify-plugin-wrapped like any other first-party plugin: a second registration on the exact
  // same context is refused before Fastify ever sees it, same as two `.with(cors)` calls would be.
  it('refuses a second registration on the same context', async () => {
    const server = fastify()
    const app = createWebApplication(fastifyAdapterFactory(server))
      .with(HTTPCaching(b => b.statusHeader('X-First')))
      .with(HTTPCaching(b => b.statusHeader('X-Second')))
      .build()
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(/Cannot register plugin "@caffeinejs\/caching"/)
  })
})
