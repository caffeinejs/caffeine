import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fastify, { type RouteOptions } from 'fastify'
import {
  Cache,
  CacheInvalidate,
  Controller,
  Get,
  Post,
  type WebApplication,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

/**
 * What a route costs when it uses none of the features that attach hooks.
 *
 * The pipeline and the cache both attach per route rather than per server, so an application that uses
 * neither must register routes with empty hook slots — not slots holding an empty or one-element array. This
 * is the guard against a later change quietly making some hook unconditional.
 */

@Controller('/hooks')
class HookController {
  @Get('/plain')
  plain() {
    return { ok: true }
  }

  @Cache({ ttl: '5m' })
  @Get('/cached')
  cached() {
    return { ok: true }
  }

  @Cache(false)
  @Get('/uncached')
  uncached() {
    return { ok: true }
  }

  @CacheInvalidate({ paths: ['/hooks/cached'] })
  @Post('/mutate')
  mutate() {
    return { ok: true }
  }
}
void [HookController]

const registered = new Map<string, RouteOptions>()
let app: WebApplication

beforeAll(async () => {
  const server = fastify()
  // onRoute sees the route definition exactly as it was handed to Fastify, after everything attached to it.
  server.addHook('onRoute', route => {
    registered.set(`${route.method} ${route.url}`, route as RouteOptions)
  })

  app = createWebApplication(fastifyAdapterFactory(server)).build()
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('route hook slots', () => {
  it('leaves both slots empty on a route that uses no feature', () => {
    const route = registered.get('GET /hooks/plain')!

    expect(route).toBeDefined()
    expect(route.onRequest).toBeUndefined()
    expect(route.onSend).toBeUndefined()
  })

  it('gives a @Cache route a function in each slot, not a one-element array', () => {
    const route = registered.get('GET /hooks/cached')!

    expect(typeof route.onRequest).toBe('function')
    expect(typeof route.onSend).toBe('function')
  })

  it('gives a @Cache(false) route the store hook only — it has nothing to serve', () => {
    const route = registered.get('GET /hooks/uncached')!

    expect(route.onRequest).toBeUndefined()
    expect(typeof route.onSend).toBe('function')
  })

  it('gives a @CacheInvalidate route the eviction hook only', () => {
    const route = registered.get('POST /hooks/mutate')!

    expect(route.onRequest).toBeUndefined()
    expect(typeof route.onSend).toBe('function')
  })
})
