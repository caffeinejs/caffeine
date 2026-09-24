import { gunzipSync } from 'node:zlib'

import { authenticationExempt, health, newRouter, type WebApplication } from '@caffeinejs/http'
import fastifyCompress from '@fastify/compress'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { spaMount, staticFiles } from '../../index.js'
import {
  clientRouteOf,
  dist,
  expectNotFoundJSON,
  fixtures,
  HeaderAuthenticationHandler,
  isolated,
  NAVIGATION,
  notFound,
  PROBE,
  shellOf,
} from './_headers.js'

const api = () =>
  newRouter('/api')
    .get('/pets', () => ({ pets: [] }))
    .get('/*', notFound)

const pages = () =>
  newRouter()
    .detail('http', { internal: true })
    .authorize({ allowAnonymous: true })
    .get('/', shellOf(dist))
    .get('/index.html', shellOf(dist))
    .get('/*', clientRouteOf(dist))

const files = () => staticFiles(s => s.serve(dist, spaMount(), { anonymous: true }))

describe('a single-page application next to the plugins an application runs in production', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('leaves the health probes to the health plugin', async () => {
    app = isolated().with(health()).with(files()).mount(api(), pages()) as WebApplication
    await app.ready()

    const live = await app.fetch('/livez', { headers: PROBE })
    expect(live.status).toBe(200)
    expect(await live.text()).toBe('ok')
    expect(live.headers.get('cache-control')).toBe('no-store')

    expect((await app.fetch('/livez', { method: 'HEAD', headers: PROBE })).status).toBe(200)
    await expectNotFoundJSON(await app.fetch('/livez/extra', { headers: PROBE }))
  })

  // A probe is not a browser: a disabled probe path is a 404 the orchestrator can act on, not a page.
  it('does not answer a disabled probe with the shell', async () => {
    app = isolated()
      .with(health(h => h.enabled(false)))
      .with(files())
      .mount(api(), pages()) as WebApplication
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/livez', { headers: PROBE }))
  })

  it('coexists with a CORS plugin', async () => {
    app = isolated()
      .with(() =>
        fp(async (instance: FastifyInstance) => instance.register(fastifyCors, { origin: 'https://app.example' }), {
          name: 'cors',
        }),
      )
      .with(files())
      .mount(api(), pages()) as WebApplication
    await app.ready()

    const preflight = await app.fetch('/api/pets', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example')

    const page = await app.fetch('/dashboard', { headers: NAVIGATION })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
  })

  it('is compressed by a compression plugin like any response', async () => {
    app = isolated()
      .with(() =>
        fp(async (instance: FastifyInstance) => instance.register(fastifyCompress, { threshold: 0 }), {
          name: 'compress',
        }),
      )
      .with(files())
      .mount(api(), pages()) as WebApplication
    await app.ready()

    const res = await app.fetch('/dashboard', { headers: { ...NAVIGATION, 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('<div id="root">')
  })

  // The client routes are ordinary routes, so the one not-found handler a Fastify context allows stays the
  // application's own.
  it('leaves a not-found handler the application set on the server itself', async () => {
    app = isolated()
      .serverCallback((_context, server) => {
        server.setNotFoundHandler((_req, reply) => {
          void reply.code(418).send({ mine: true })
        })
      })
      .with(files())
      .mount(api(), pages()) as WebApplication
    await app.ready()

    expect((await app.fetch('/nope', { method: 'POST' })).status).toBe(418)

    const page = await app.fetch('/dashboard', { headers: NAVIGATION })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
  })

  // Installed before the static plugin on purpose: a raw route needs to declare nothing to be respected.
  it('respects a raw Fastify route a plugin registered before it', async () => {
    app = isolated()
      .with(() =>
        fp(
          async (instance: FastifyInstance) => {
            instance.get('/metrics', { config: authenticationExempt() }, async () => 'up 1')
          },
          { name: 'metrics' },
        ),
      )
      .with(files())
      .mount(api(), pages()) as WebApplication
    await app.ready()

    const metrics = await app.fetch('/metrics', { headers: PROBE })
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toBe('up 1')

    // An exact URL that matched a route never reaches the client-route wildcard; a miss beside it does, and
    // a probe is not a browser.
    await expectNotFoundJSON(await app.fetch('/metrics/x', { headers: PROBE }))
  })

  // `@fastify/static`'s default wildcard registers `GET /*`, which is the application's own client-route
  // path. That used to make the shell silently unreachable; now it is a duplicate route at start-up. This is
  // what `spaMount()` turns off, and why it is not a tuning knob.
  it('refuses to start next to a catch-all static mount the application registered itself', async () => {
    app = isolated()
      .with(() =>
        fp(
          async (instance: FastifyInstance) => instance.register(fastifyStatic, { root: dist, decorateReply: false }),
          {
            name: 'my-static',
          },
        ),
      )
      .with(files())
      .mount(api(), pages()) as WebApplication

    await expect(app.ready()).rejects.toThrow(/already declared/)
  })

  // `@fastify/static` forwards a route config only on the per-file routes it registers: the wildcard it
  // registers by default, and the redirect beside it, arrive without one. Marking an `anonymous` mount from an
  // `onRoute` hook has to reach those too, or a mount serving on the default `wildcard: true` — where the
  // wildcard *is* every route it has — is exempt in name only and answers 401 for the whole bundle.
  it('exempts the wildcard route of an anonymous mount, not only its per-file routes', async () => {
    app = isolated()
      .authentication(auth => auth.addStrategy('header', new HeaderAuthenticationHandler()))
      .authorization(authz => authz.requireAuthenticatedByDefault())
      .with(staticFiles(s => s.serve(fixtures, { prefix: '/bundle' }, { anonymous: true }))) as WebApplication
    await app.ready()

    const asset = await app.fetch('/bundle/hello.txt', { headers: PROBE })

    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('hello static world')
  })

  // A second mount that also wants the decoration is refused earlier still, by Fastify itself.
  it('refuses a second mount that also asks to decorate the reply', async () => {
    app = isolated()
      .with(() =>
        fp(async (instance: FastifyInstance) => instance.register(fastifyStatic, { root: dist, prefix: '/mine' }), {
          name: 'my-static',
        }),
      )
      .with(files())
      .mount(api(), pages()) as WebApplication

    await expect(app.ready()).rejects.toThrow(/has already been added/)
  })
})
