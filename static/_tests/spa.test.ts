import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import type { ServiceAPI } from '@caffeinejs/std'
import { ErrDuplicateSPAMount, ErrSPAIndexMissing, type StaticBuilder, staticPlugin } from '../index.js'

const dist = fileURLToPath(new URL('./_testdata/spa', import.meta.url))
const empty = fileURLToPath(new URL('./_testdata/fixtures2', import.meta.url))

// Declared at module scope: the container snapshots the controller registry when it is constructed, so a
// controller declared inside a test would not be routed.
@Controller('/api')
class APIController {
  @Get('/pets')
  pets(): unknown {
    return { pets: [] }
  }
}
void [APIController]

describe('SPA fallback', () => {
  let app: WebApplication | undefined

  const start = async (configure: (builder: ServiceAPI<StaticBuilder>) => void) => {
    app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .static(configure)
      .build()
    await app.ready()

    return app
  }

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('serves the shell at the root', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('serves the shell for a client-side route, revalidated', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/convite/abc')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('<div id="root">')
  })

  it('caches a hashed asset indefinitely', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/assets/app-eZr2sdaR.js')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toContain('spa bundle')
  })

  it('404s a missing asset instead of serving HTML', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/assets/app-deadbeef.js')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toMatchObject({ statusCode: 404, code: 'ERR_HTTP_NOT_FOUND' })
  })

  it('keeps an unmatched API path a JSON 404, with no exclude configured', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/api/typo')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' })
  })

  it('still routes the real API route', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/api/pets')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pets: [] })
  })

  it('does not answer a non-GET with the shell', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/convite/abc', { method: 'POST' })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  })

  it('does not answer a programmatic fetch with the shell', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/convite/abc', { headers: { 'sec-fetch-dest': 'empty' } })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  })

  it('answers a browser navigation with the shell', async () => {
    const started = await start(s => s.spa(dist))

    const res = await started.fetch('/convite/abc', { headers: { 'sec-fetch-dest': 'document' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
  })

  it('honours an explicit exclude', async () => {
    const started = await start(s => s.spa(dist, { exclude: ['/webhooks'] }))

    const res = await started.fetch('/webhooks/stripe')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  })

  it('include wins over a derived server-owned prefix', async () => {
    const started = await start(s => s.spa(dist, { include: ['/api/docs'] }))

    const res = await started.fetch('/api/docs')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
  })

  it('serves the API alone when the shell is missing and onMissingIndex is skip', async () => {
    const started = await start(s => s.spa(empty, { onMissingIndex: 'skip' }))

    expect((await started.fetch('/api/pets')).status).toBe(200)
    expect((await started.fetch('/convite/abc')).status).toBe(404)
  })

  it('refuses to start when the shell is missing', async () => {
    const failing = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
      .extend(staticPlugin())
      .static(s => s.spa(empty))
      .build()

    await expect(failing.ready()).rejects.toThrow(ErrSPAIndexMissing)
    await failing.close()
  })

  it('refuses a second SPA mount', () => {
    expect(() =>
      createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {})
        .extend(staticPlugin())
        .static(s => s.spa(dist).spa(dist))
        .build(),
    ).toThrow(ErrDuplicateSPAMount)
  })
})
