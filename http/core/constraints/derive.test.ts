import { Injectable } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { node } from '../../platform/node.testkit.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrRouteConflict } from '../matcher/matcher.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { ConstraintRequest, ConstraintStorage, ConstraintStrategy } from './constraints.js'
import { constraint, version } from './route.js'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

/** An exact-match store: a route registers under a string, a request names it. */
function exact(): ConstraintStorage {
  const stores = new Map<string, unknown>()
  return { get: value => stores.get(value) ?? null, set: (value, store) => void stores.set(value, store) }
}

/** An exact-match strategy reading `header`, which a route not naming it never matches once a request derives it. */
function strategy(name: string, header: string): ConstraintStrategy {
  return { name, mustMatchWhenDerived: true, storage: exact, deriveConstraint: req => req.header(header) }
}

const pets = () =>
  new Router('/pets')
    .config(version('1.0.0'))
    .get('/')
    .handler(() => 'v1')
const plain = () => new Router('/plain').get('/').handler(() => 'plain')

/** `/d`, answering the flavor its request names. */
function dish() {
  return new Router('/d')
    .get('/')
    .name('spicy')
    .config(constraint('flavor', 'spicy', { header: 'X-Flavor' }))
    .handler(() => 'spicy')
    .get('/')
    .name('mild')
    .config(constraint('flavor', 'mild', { header: 'X-Flavor' }))
    .handler(() => 'mild')
}

describe('route constraints on the engine', () => {
  // A request asking for a version reaches only a versioned route, as on Fastify, once the server versions any.
  it('answers 404 to a version asked of an unversioned route, once a route is versioned', async () => {
    const versioned = createWebApplication().mount(pets(), plain())
    app = versioned
    await versioned.bootstrap()

    expect((await versioned.request('/plain', { headers: { 'accept-version': '9.x' } })).status).toBe(404)
    await versioned.close()

    const unversioned = createWebApplication().mount(plain())
    app = unversioned
    await unversioned.bootstrap()

    expect((await unversioned.request('/plain', { headers: { 'accept-version': '9.x' } })).status).toBe(200)
  })

  // A cache keyed on the URL alone would serve one client the other's answer: a miss varies too.
  it('varies a miss on the declared header', async () => {
    const built = createWebApplication().mount(pets())
    app = built
    await built.bootstrap()

    const res = await built.request('/nope')

    expect(res.status).toBe(404)
    // The problem answer varies on Accept of its own.
    expect(res.headers.get('vary')).toBe('Accept, Accept-Version')
  })

  it('answers HEAD on a versioned GET only for its version', async () => {
    const built = createWebApplication().mount(pets())
    app = built
    await built.bootstrap()

    const head = await built.request('/pets', { method: 'HEAD', headers: { 'accept-version': '1.x' } })

    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await built.request('/pets', { method: 'HEAD' })).status).toBe(404)
  })

  it('selects a route by a strategy set on the server', async () => {
    const flavor = strategy('flavor', 'x-flavor')
    const built = createWebApplication()
      .server(() => ({ constraints: [flavor] }))
      .mount(dish())
    app = built
    await built.bootstrap()

    const spicy = await built.request('/d', { headers: { 'x-flavor': 'spicy' } })

    expect(await spicy.text()).toBe('spicy')
    expect(spicy.headers.get('vary')).toBe('X-Flavor')
    expect(await (await built.request('/d', { headers: { 'x-flavor': 'mild' } })).text()).toBe('mild')
  })

  it('selects a route by a strategy resolved out of the container', async () => {
    @Injectable()
    class Flavor implements ConstraintStrategy {
      readonly name = 'flavor'
      readonly mustMatchWhenDerived = true
      readonly header = 'x-flavor'

      storage(): ConstraintStorage {
        return exact()
      }

      deriveConstraint(req: ConstraintRequest): string | undefined {
        return req.header(this.header)
      }
    }

    const built = createWebApplication()
      .server(({ container }) => ({ constraints: [container.get(Flavor)] }))
      .mount(dish())
    app = built
    await built.bootstrap()

    expect(await (await built.request('/d', { headers: { 'x-flavor': 'mild' } })).text()).toBe('mild')
  })

  // A route that narrows a versioned router must stay versioned: dropping the version would serve every version.
  it('keeps its router’s version on a route that adds a constraint of its own', async () => {
    const built = createWebApplication()
      .server(() => ({ constraints: [strategy('flavor', 'X-Flavor')] }))
      .mount(
        new Router('/v')
          .config(version('1.0.0'))
          .get('/')
          .config(constraint('flavor', 'x', { header: 'X-Flavor' }))
          .handler(() => 'ok'),
      )
    app = built
    await built.bootstrap()

    expect((await built.request('/v', { headers: { 'x-flavor': 'x' } })).status).toBe(404)
    expect((await built.request('/v', { headers: { 'x-flavor': 'x', 'accept-version': '1.x' } })).status).toBe(200)
    expect((await built.request('/v', { headers: { 'x-flavor': 'y', 'accept-version': '1.x' } })).status).toBe(404)
  })

  it('refuses a constraint no strategy is named after', async () => {
    const built = createWebApplication().mount(
      new Router('/x')
        .get('/')
        .config(constraint('nope', 1))
        .handler(() => 'x'),
    )
    app = built

    const booting = built.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow('Cannot serve "GET /x": no constraint strategy is named "nope"')
  })

  it('refuses constraints written into the route options by hand', async () => {
    const built = createWebApplication().mount(
      new Router('/x')
        .get('/')
        .config({ constraints: { version: '1.0.0' } } as never)
        .handler(() => 'x'),
    )
    app = built

    await expect(built.bootstrap()).rejects.toThrow(
      'Cannot serve "GET /x": its constraints are not declared with constraint() or version()',
    )
  })

  // An empty declaration constrains nothing: the route is taken as an unconstrained one.
  it('takes an empty declaration for none', async () => {
    const empty = () =>
      new Router('/e')
        .get('/')
        .config({ constraints: new Map() })
        .handler(() => 'e')
    const built = createWebApplication().mount(empty(), empty())
    app = built

    await expect(built.bootstrap()).rejects.toThrow(
      'Cannot register "GET /e": a route with this method and path is already registered',
    )
  })

  it('refuses two routes of one path and version', async () => {
    const built = createWebApplication().mount(pets(), pets())
    app = built

    await expect(built.bootstrap()).rejects.toThrow(ErrRouteConflict)
  })

  // The fetch platform reads the host off the request's URL when no Host header names it.
  it('selects a route by the host the request names', async () => {
    const built = createWebApplication().mount(
      new Router('/h')
        .get('/')
        .config(constraint('host', 'api.example'))
        .handler(() => 'h'),
    )
    app = built
    await built.bootstrap()

    expect((await built.fetch(new Request('http://api.example/h'))).status).toBe(200)
    expect((await built.fetch(new Request('http://other.example/h'))).status).toBe(404)
  })

  it('lets a strategy replace the built-in version', async () => {
    const built = createWebApplication()
      .server(() => ({ constraints: [strategy('version', 'x-api')] }))
      .mount(
        new Router('/api')
          .get('/')
          .config(constraint('version', 'v7'))
          .handler(() => 'v7'),
      )
    app = built
    await built.bootstrap()

    expect((await built.request('/api', { headers: { 'x-api': 'v7' } })).status).toBe(200)
  })

  it('fails the request when a strategy throws', async () => {
    const boom: ConstraintStrategy = {
      name: 'boom',
      storage: exact,
      deriveConstraint: () => {
        throw new Error('boom')
      },
    }
    const built = createWebApplication()
      .server(() => ({ constraints: [boom] }))
      .mount(
        new Router('/b')
          .get('/')
          .config(constraint('boom', 'x'))
          .handler(() => 'b'),
      )
    app = built
    await built.bootstrap()

    expect((await built.request('/b')).status).toBe(500)
    expect((await built.request('/nope')).status).toBe(500)
  })

  it("reads a strategy's header from a Node request", async () => {
    const built = createWebApplication({ adapter: node() })
      .server(() => ({ constraints: [strategy('flavor', 'x-flavor')] }))
      .mount(dish())
    app = built
    await built.bootstrap()

    expect(await (await built.request('/d', { headers: { 'x-flavor': 'mild' } })).text()).toBe('mild')
  })

  it('varies on the header of a constrained route a plugin mounts', async () => {
    const built = createWebApplication()
      .server(() => ({ constraints: [strategy('flavor', 'x-flavor')] }))
      .with(
        () =>
          new (class extends HTTPPlugin {
            register(context: HTTPSetupContext): void {
              context.app.mount(
                new Router('/late')
                  .config(constraint('flavor', 'spicy', { header: 'X-Flavor' }))
                  .get('/')
                  .handler(() => 'late'),
              )
            }
          })(),
      )
    app = built
    await built.bootstrap()

    const res = await built.request('/late', { headers: { 'x-flavor': 'spicy' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('vary')).toBe('X-Flavor')
  })

  // Nothing is constrained, so no answer pays for a header.
  it('leaves Vary alone on a server with no constrained route', async () => {
    const built = createWebApplication().mount(plain())
    app = built
    await built.bootstrap()

    expect((await built.request('/plain')).headers.get('vary')).toBe(null)
  })
})
