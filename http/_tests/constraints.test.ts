import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  constraint,
  constraintsPlugin,
  createWebApplication,
  fastifyAdapterFactory,
  fst,
  kRouteConstraints,
  Router,
  version,
} from '../index.js'
import type { ConstraintStrategy } from '../index.js'
import { RouteBuilder } from '../routing/builder.js'

/** A trivial exact-match strategy: routes register under a string, requests derive from a header. */
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

describe('route constraints', () => {
  it('a registered custom strategy selects the route and contributes its header to Vary', async () => {
    const dish = new Router('/dish')
    dish
      .get('/')
      .name('spicy')
      .with(constraint('flavor', 'spicy', { header: 'X-Flavor' }))
      .handler(() => ({ flavor: 'spicy' }))
    dish
      .get('/')
      .name('mild')
      .with(constraint('flavor', 'mild', { header: 'X-Flavor' }))
      .handler(() => ({ flavor: 'mild' }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .with(() => constraintsPlugin([flavorStrategy()]))
      .mount(dish)
    await app.ready()

    const spicy = await app.fetch('/dish', { headers: { 'x-flavor': 'spicy' } })
    expect(await spicy.json()).toEqual({ flavor: 'spicy' })
    expect(spicy.headers.get('vary')).toContain('X-Flavor')

    expect(await (await app.fetch('/dish', { headers: { 'x-flavor': 'mild' } })).json()).toEqual({ flavor: 'mild' })

    await app.close()
  })

  it('fails at ready() when a route names a constraint no strategy is registered under', async () => {
    const r = new Router('/x')
    r.get('/')
      .with(constraint('nope', 1))
      .handler(() => ({}))
    const app = createWebApplication({ container: new CaffeineIoC() }).mount(r)

    // find-my-way's own error, surfaced when the route registers — there is no more central registry to
    // check the name against ahead of time.
    await expect(app.ready()).rejects.toThrow(/no strategy registered for constraint key nope/i)
  })

  it('fails at ready() when fst and version() both set the version constraint on one route', async () => {
    const r = new Router('/c')
    r.get('/')
      .with(version('2.0.0'), fst({ constraints: { version: '1.0.0' } }))
      .handler(() => ({}))
    const app = createWebApplication({ container: new CaffeineIoC() }).mount(r)

    await expect(app.ready()).rejects.toThrow(/constraint "version" is set by both/)
  })

  it('lets an fst host constraint coexist with a first-class version constraint', async () => {
    const r = new Router('/c')
    r.get('/')
      .name('coexist')
      .with(version('1.0.0'), fst({ constraints: { host: 'api.example' } }))
      .handler(() => ({ ok: true }))
    const app = createWebApplication({ container: new CaffeineIoC() }).mount(r)
    await app.ready()

    const res = await app.fetch('/c', { headers: { 'accept-version': '1.x', host: 'api.example' } })
    expect(await res.json()).toEqual({ ok: true })

    await app.close()
  })

  it('constraint() writes the declared value and header into route.config', () => {
    const built = new RouteBuilder().method('GET').path('/').name('x')
    constraint('flavor', 'spicy', { header: 'X-Flavor' })(built)

    expect(built.toRoute().config?.get(kRouteConstraints)).toEqual(
      new Map([['flavor', { value: 'spicy', header: 'X-Flavor' }]]),
    )
  })
})
