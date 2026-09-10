import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { constraint } from '../decorators/constraint.js'
import { Router, createWebApplication, fastifyAdapterFactory, fst } from '../index.js'
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
      .constraint('flavor', 'spicy')
      .handler(() => ({ flavor: 'spicy' }))
    dish
      .get('/')
      .name('mild')
      .constraint('flavor', 'mild')
      .handler(() => ({ flavor: 'mild' }))

    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .constraints(c => c.register(flavorStrategy(), { header: 'X-Flavor' }))
      .build()
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
      .constraint('nope', 1)
      .handler(() => ({}))
    const app = createWebApplication({ container: new CaffeineIoC() }).build().mount(r)

    await expect(app.ready()).rejects.toThrow(/unknown route constraint "nope"/)
  })

  it('fails at ready() when fst and .version() both set the version constraint on one route', async () => {
    const r = new Router('/c')
    r.get('/')
      .version('2.0.0')
      .with(fst({ constraints: { version: '1.0.0' } }))
      .handler(() => ({}))
    const app = createWebApplication({ container: new CaffeineIoC() }).build().mount(r)

    await expect(app.ready()).rejects.toThrow(/constraint "version" is set by both/)
  })

  it('lets an fst host constraint coexist with a first-class version constraint', async () => {
    const r = new Router('/c')
    r.get('/')
      .name('coexist')
      .version('1.0.0')
      .with(fst({ constraints: { host: 'api.example' } }))
      .handler(() => ({ ok: true }))
    const app = createWebApplication({ container: new CaffeineIoC() }).build().mount(r)
    await app.ready()

    const res = await app.fetch('/c', { headers: { 'accept-version': '1.x', host: 'api.example' } })
    expect(await res.json()).toEqual({ ok: true })

    await app.close()
  })

  it('the constraint() extension and the builder method are one implementation, not two', () => {
    // `@Constraint` / `@Version` route through `constraint()`; `Router.constraint()` / `.version()` route
    // through `RouteBuilder.constraint()`. A drift between them would let a decorated and a programmatic route
    // compile to different Fastify constraints for the same declaration.
    const viaExtension = new RouteBuilder().method('GET').path('/').name('x')
    constraint('version', '1.0.0')(viaExtension)

    const viaMethod = new RouteBuilder().method('GET').path('/').name('x')
    viaMethod.constraint('version', '1.0.0')

    expect(viaExtension.toRoute().constraints).toEqual(viaMethod.toRoute().constraints)
    expect(viaExtension.toRoute().constraints).toEqual(new Map([['version', '1.0.0']]))
  })
})
