import { brotliDecompressSync } from 'node:zlib'

import { type WebApplication } from '@caffeinejs/http'
import { newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { clientRouteOf, dist, expectNotFoundJSON, isolated, NAVIGATION, SCRIPT, shellOf } from './_headers.js'

/**
 * A build that wrote `.br` and `.gz` beside every compressible file, served from its manifest.
 *
 * Two halves are easy to get wrong and neither is visible without this scenario. The variants come from the
 * manifest rather than the file system, so they serve the mount's file routes **and** `sendFile` from a compiled
 * route: the shell is compressed without the application asking. And the variants never become routes of their
 * own: a `GET` of `…/app.js.br` would otherwise answer with raw brotli, which no client asked for.
 */
function site(): WebApplication {
  return isolated()
    .with(staticFiles(s => s.serve(dist, { unrouted: ['index.html'], anonymous: true, immutable: ['assets/**'] })))
    .mount(
      newRouter()
        .detail('http', { internal: true })
        .authorize({ allowAnonymous: true })
        .get('/', shellOf(dist))
        .get('/index.html', shellOf(dist))
        .get('/*', clientRouteOf(dist)),
    ) as WebApplication
}

const SCRIPT_URL = '/assets/app-eZr2sdaR.js'

describe('a mount serving the compressed variants its build wrote', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('serves brotli to a client that accepts it, typed as the file it stands for', async () => {
    app = site()
    await app.bootstrap()

    const res = await app.request(SCRIPT_URL, { headers: { ...SCRIPT, 'accept-encoding': 'gzip, deflate, br' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('spa bundle')
  })

  it('falls back through the codings the client accepts, and to identity with no Accept-Encoding', async () => {
    app = site()
    await app.bootstrap()

    const gzip = await app.request(SCRIPT_URL, { headers: { ...SCRIPT, 'accept-encoding': 'gzip' } })
    expect(gzip.headers.get('content-encoding')).toBe('gzip')

    const plain = await app.request(SCRIPT_URL, { headers: SCRIPT })
    expect(plain.status).toBe(200)
    expect(plain.headers.get('content-encoding')).toBe(null)
    // A shared cache that stored this copy must not hand it to a client that asked for brotli, nor the reverse.
    expect(plain.headers.get('vary')).toBe('Accept-Encoding')
    expect(await plain.text()).toContain('spa bundle')
  })

  it('compresses the shell served from a compiled route', async () => {
    app = site()
    await app.bootstrap()

    const res = await app.request('/', { headers: { ...NAVIGATION, 'accept-encoding': 'br' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('does not register the variants as routes of their own', async () => {
    app = site()
    await app.bootstrap()

    for (const path of [`${SCRIPT_URL}.br`, `${SCRIPT_URL}.gz`]) {
      await expectNotFoundJSON(await app.request(path, { headers: NAVIGATION }))
    }
  })

  it('caches the variant of a hashed asset immutably, as its identity', async () => {
    app = site()
    await app.bootstrap()

    const res = await app.request(SCRIPT_URL, { headers: { ...SCRIPT, 'accept-encoding': 'br' } })

    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})
