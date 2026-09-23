import { gunzipSync } from 'node:zlib'

import { health, kAuthenticationExempt, newRouter, type WebApplication } from '@caffeinejs/http'
import fastifyCompress from '@fastify/compress'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { dist, expectNotFoundJSON, isolated, NAVIGATION, PROBE } from './_headers.js'

const api = () => newRouter('/api').get('/pets', () => ({ pets: [] }))

describe('the shell next to the plugins an application runs in production', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('leaves the health probes to the health plugin', async () => {
    app = isolated()
      .with(health())
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication
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
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication
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
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication
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
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication
    await app.ready()

    const res = await app.fetch('/dashboard', { headers: { ...NAVIGATION, 'accept-encoding': 'gzip' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('<div id="root">')
  })

  // The shell is a route, so the one not-found handler a Fastify context allows stays the application's.
  it('leaves a not-found handler the application set on the server itself', async () => {
    app = isolated()
      .server(undefined, server => {
        server.setNotFoundHandler((_req, reply) => {
          void reply.code(418).send({ mine: true })
        })
      })
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication
    await app.ready()

    const mine = await app.fetch('/nope', { method: 'POST' })
    expect(mine.status).toBe(418)

    const page = await app.fetch('/dashboard', { headers: NAVIGATION })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
  })

  // Installed before the static plugin on purpose: a raw route needs to declare nothing for the shell to respect it.
  it('respects a raw Fastify route a plugin registered before it', async () => {
    app = isolated()
      .with(() =>
        fp(
          async (instance: FastifyInstance) => {
            instance.get('/metrics', { config: { [kAuthenticationExempt]: true } }, async () => 'up 1')
          },
          { name: 'metrics' },
        ),
      )
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication
    await app.ready()

    const metrics = await app.fetch('/metrics', { headers: PROBE })
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toBe('up 1')

    await expectNotFoundJSON(await app.fetch('/metrics/x', { headers: PROBE }))
  })

  // Refused by the adapter's duplicate-plugin check, before the two shells could even collide as routes.
  it('refuses a second staticFiles', async () => {
    app = isolated()
      .with(staticFiles(s => s.spa(dist)))
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication

    await expect(app.ready()).rejects.toThrow(/already registered/)
  })

  // `@fastify/static`'s default wildcard used to make the shell silently unreachable; a duplicate route is loud.
  it('refuses to start next to a catch-all static mount the application registered itself', async () => {
    app = isolated()
      .with(() =>
        fp(async (instance: FastifyInstance) => instance.register(fastifyStatic, { root: dist }), {
          name: 'my-static',
        }),
      )
      .with(staticFiles(s => s.spa(dist)))
      .mount(api()) as WebApplication

    await expect(app.ready()).rejects.toThrow(/already declared/)
  })
})
