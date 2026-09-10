import fastify, { type RouteOptions } from 'fastify'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { Controller, Get, type WebApplication, createWebApplication, fastifyAdapterFactory } from '../index.js'

/**
 * What a route costs when it uses none of the features that attach hooks.
 *
 * The pipeline, guards and any route contributor attach per route rather than per server, so an application
 * that uses none of them must register routes with empty hook slots — not slots holding an empty or
 * one-element array. This is the guard against a later change quietly making some hook unconditional.
 */

@Controller('/hooks')
class HookController {
  @Get('/plain')
  plain() {
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
})
