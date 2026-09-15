import fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'

import { Router, createWebApplication, fastifyAdapterFactory, type ConstraintStrategy } from '../index.js'
import { RouteBuilder } from '../routing/builder.js'

/** Exact-match strategy reading `x-flavor`, so a route can be selected on a header. */
function flavorStrategy(): ConstraintStrategy {
  return {
    name: 'flavor',
    mustMatchWhenDerived: true,
    storage() {
      const map = new Map<string, unknown>()
      return {
        get: value => map.get(value) ?? null,
        set: (value, handler) => void map.set(value, handler),
      }
    },
    deriveConstraint: req => (req.headers['x-flavor'] as string | undefined) || undefined,
  }
}

describe('constraint Vary header', () => {
  // The Vary plugin registers before any route. It learns the constrained headers from `onRoute`, so a route a
  // later plugin adds counts as much as a mounted one — a shared cache would otherwise mix the representations.
  it('covers a constrained route a plugin added with $route', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .constraints(c => c.register(flavorStrategy(), { header: 'X-Flavor' }))
      .with(() => async (instance: FastifyInstance) => {
        instance.$route('late', router => {
          router
            .path('/late')
            .constraint('flavor', 'spicy')
            .routes([
              new RouteBuilder()
                .method('GET')
                .path('/')
                .handle(() => ({ ok: true })),
            ])
        })
      })
    await app.ready()

    const res = await app.fetch('/late', { headers: { 'x-flavor': 'spicy' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('vary')).toContain('X-Flavor')

    await app.close()
  })

  it('leaves Vary alone when no route is constrained', async () => {
    const plain = new Router('/plain')
    plain.get('/').handler(() => ({ ok: true }))

    const app = createWebApplication(fastifyAdapterFactory(fastify())).mount(plain)
    await app.ready()

    const res = await app.fetch('/plain')

    expect(res.status).toBe(200)
    expect(res.headers.get('vary')).toBeNull()

    await app.close()
  })
})
