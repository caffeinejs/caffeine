import { fileURLToPath } from 'node:url'

import { newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { immutableAssets, spaMount, staticFiles } from '../../index.js'
import { clientRouteOf, expectNotFoundJSON, isolated, NAVIGATION, SCRIPT, shellOf } from './_headers.js'

/**
 * A build that ships `.br` and `.gz` next to every file, served with `preCompressed`.
 *
 * Two halves are easy to get wrong and neither is visible without this scenario. `preCompressed` resolves the
 * sibling on the file system rather than through the router, so it works for the mount's file routes **and**
 * for `sendFile` from a compiled route — the shell is compressed without the application asking. And the
 * siblings must not become routes of their own: `spaMount()` ignores them, because a `GET` of
 * `…/app.js.br` would otherwise answer with raw brotli under `application/octet-stream` and no
 * `Content-Encoding`, which no client can read.
 */
const dist = fileURLToPath(new URL('../_testdata/compressed', import.meta.url))

function site(): WebApplication {
  return isolated()
    .with(
      staticFiles(s =>
        s.serve(dist, { ...spaMount(), preCompressed: true, setHeaders: immutableAssets(dist) }, { anonymous: true }),
      ),
    )
    .mount(
      newRouter()
        .detail('http', { internal: true })
        .authorize({ allowAnonymous: true })
        .get('/', shellOf(dist))
        .get('/index.html', shellOf(dist))
        .get('/*', clientRouteOf(dist)),
    ) as WebApplication
}

describe('a mount serving pre-compressed siblings', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('serves brotli to a client that accepts it', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/assets/app-Ab12Cd34.js', {
      headers: { ...SCRIPT, 'accept-encoding': 'br' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('vary') ?? '').toContain('accept-encoding')
    // The content type stays the uncompressed file's, not the sibling's.
    expect(res.headers.get('content-type') ?? '').toContain('javascript')
  })

  it('falls back through the encodings the client actually accepts', async () => {
    app = site()
    await app.ready()

    const gzip = await app.fetch('/assets/app-Ab12Cd34.js', {
      headers: { ...SCRIPT, 'accept-encoding': 'gzip' },
    })
    expect(gzip.headers.get('content-encoding')).toBe('gzip')

    // No `Accept-Encoding` at all: the identity bytes, and nothing invented.
    const plain = await app.fetch('/assets/app-Ab12Cd34.js', { headers: SCRIPT })
    expect(plain.status).toBe(200)
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toContain('compressed bundle')
  })

  // `sendFile` goes through the same pump and reads `preCompressed` off the plugin's registration closure,
  // so a compiled route serving the shell gets it without asking.
  it('compresses the shell served from a compiled route', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/', { headers: { ...NAVIGATION, 'accept-encoding': 'br' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('content-type') ?? '').toContain('text/html')
  })

  // What `spaMount()`'s globIgnore is for: reachable as its own URL, this would hand out unreadable bytes.
  it('does not register the compressed siblings as routes of their own', async () => {
    app = site()
    await app.ready()

    for (const path of ['/assets/app-Ab12Cd34.js.br', '/assets/app-Ab12Cd34.js.gz']) {
      await expectNotFoundJSON(await app.fetch(path, { headers: NAVIGATION }))
    }
  })

  it('still caches the hashed assets immutably', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/assets/app-Ab12Cd34.js', {
      headers: { ...SCRIPT, 'accept-encoding': 'br' },
    })

    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})
