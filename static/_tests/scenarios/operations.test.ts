import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { type WebApplication } from '@caffeinejs/http'
import { authenticationExempt, compress, newRouter, healthProbes } from '@caffeinejs/http/fastify'
import fastifyCompress from '@fastify/compress'
import fastifyCors from '@fastify/cors'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { clientRouteOf, dist, expectNotFoundJSON, isolated, NAVIGATION, notFound, PROBE, shellOf } from './_headers.js'

const api = () =>
  newRouter('/api')
    .get('/pets', () => ({ pets: [] }))
    .get('/*', notFound)

const pages = () =>
  newRouter()
    .extend(compress(false))
    .detail('http', { internal: true })
    .authorize({ allowAnonymous: true })
    .get('/', shellOf(dist))
    .get('/index.html', shellOf(dist))
    .get('/*', clientRouteOf(dist))

const files = () => staticFiles(s => s.serve(dist, { unrouted: ['index.html'], anonymous: true }))

describe('a single-page application next to the plugins an application runs in production', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('leaves the health probes to the health plugin', async () => {
    app = isolated().with(healthProbes()).with(files()).mount(api(), pages()) as WebApplication
    await app.bootstrap()

    const live = await app.request('/livez', { headers: PROBE })
    expect(live.status).toBe(200)
    expect(await live.text()).toBe('ok')
    expect(live.headers.get('cache-control')).toBe('no-store')

    expect((await app.request('/livez', { method: 'HEAD', headers: PROBE })).status).toBe(200)
    await expectNotFoundJSON(await app.request('/livez/extra', { headers: PROBE }))
  })

  // A probe is not a browser: a disabled probe path is a 404 the orchestrator can act on, not a page.
  it('does not answer a disabled probe with the shell', async () => {
    app = isolated()
      .with(healthProbes(h => h.enabled(false)))
      .with(files())
      .mount(api(), pages()) as WebApplication
    await app.bootstrap()

    await expectNotFoundJSON(await app.request('/livez', { headers: PROBE }))
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
    await app.bootstrap()

    const preflight = await app.request('/api/pets', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example')

    const page = await app.request('/dashboard', { headers: NAVIGATION })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
  })

  it.each(['manifest', 'scan'] as const)(
    'keeps the selected file representation with a global compression plugin in %s mode',
    async mode => {
      app = isolated()
        .with(() =>
          fp(
            async (instance: FastifyInstance) =>
              instance.register(fastifyCompress, {
                threshold: 0,
                onUnsupportedEncoding: (_encoding, _request, reply) => {
                  reply.code(406)
                  return 'Unsupported response encoding'
                },
              }),
            { name: 'compress' },
          ),
        )
        .with(staticFiles(s => s.serve(dist, { mode, unrouted: ['index.html'], anonymous: true })))
        .mount(api(), pages()) as WebApplication
      await app.bootstrap()

      const headers = { ...NAVIGATION, 'accept-encoding': 'gzip' }
      for (const path of ['/assets/app-eZr2sdaR.js', '/dashboard']) {
        const res = await app.request(path, { headers })
        const head = await app.request(path, { method: 'HEAD', headers })
        const bytes = Buffer.from(await res.arrayBuffer())

        expect(res.status).toBe(200)
        expect(res.headers.get('etag')).toBe(`"${createHash('sha256').update(bytes).digest('base64')}"`)
        expect(res.headers.get('content-encoding')).toBe(mode === 'manifest' ? 'gzip' : null)
        expect(head.status).toBe(200)
        expect(head.headers.get('content-encoding')).toBe(res.headers.get('content-encoding'))
        expect(head.headers.get('content-length')).toBe(String(bytes.length))
        expect(head.headers.get('etag')).toBe(res.headers.get('etag'))

        if (mode === 'manifest') {
          const resumed = await app.request(path, {
            headers: { ...headers, range: 'bytes=6-10', 'if-range': res.headers.get('etag')! },
          })
          expect(resumed.status).toBe(200)
          expect(Buffer.from(await resumed.arrayBuffer())).toEqual(gunzipSync(bytes))
        }
      }

      const pets = await app.request('/api/pets', { headers: { 'accept-encoding': 'gzip' } })
      expect(pets.headers.get('content-encoding')).toBe('gzip')
      expect(gunzipSync(Buffer.from(await pets.arrayBuffer())).toString()).toBe('{"pets":[]}')
    },
  )

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
    await app.bootstrap()

    expect((await app.request('/nope', { method: 'POST' })).status).toBe(418)

    const page = await app.request('/dashboard', { headers: NAVIGATION })
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
    await app.bootstrap()

    const metrics = await app.request('/metrics', { headers: PROBE })
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toBe('up 1')

    // An exact URL that matched a route never reaches the client-route wildcard; a miss beside it does, and
    // a probe is not a browser.
    await expectNotFoundJSON(await app.request('/metrics/x', { headers: PROBE }))
  })
})
