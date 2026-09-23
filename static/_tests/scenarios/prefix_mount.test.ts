import { newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { immutableAssets, spaMount, staticFiles } from '../../index.js'
import { clientRouteOf, dist, expectNotFoundJSON, fixtures, isolated, NAVIGATION, SCRIPT, shellOf } from './_headers.js'

/**
 * Server-rendered pages at the root, a plain file mount at `/static`, and the application under `/app`.
 *
 * The application registers `/app` itself rather than relying on a prefixed router: `newRouter('/app')` with
 * a route at `/` composes to `/app/`, and find-my-way does not match `/app` against it. `/app/` needs no
 * route of its own — `/app/*` matches it with an empty wildcard.
 */
function site(): WebApplication {
  return isolated()
    .with(
      staticFiles(s =>
        s
          .serve(fixtures, { prefix: '/static' })
          .serve(dist, { ...spaMount(), prefix: '/app', setHeaders: immutableAssets(dist) }, { anonymous: true }),
      ),
    )
    .mount(
      newRouter().get('/', ctx => ctx.header('content-type', 'text/html').body('<h1>home</h1>')),
      newRouter()
        .detail('http', { internal: true })
        .authorize({ allowAnonymous: true })
        .get('/app', shellOf(dist))
        .get('/app/index.html', shellOf(dist))
        .get('/app/*', clientRouteOf(dist)),
    ) as WebApplication
}

describe('an application mounted under a prefix', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('leaves the root to the application’s own route', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/', { headers: NAVIGATION })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>home</h1>')
  })

  it('serves the shell at the prefix, with and without a trailing slash, and for every client route under it', async () => {
    app = site()
    await app.ready()

    for (const path of ['/app', '/app/', '/app/settings', '/app/orders/42']) {
      const res = await app.fetch(path, { headers: NAVIGATION })

      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain('<div id="root">')
    }
  })

  it('serves the shell’s assets under the prefix', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/app/assets/app-eZr2sdaR.js', { headers: SCRIPT })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('serves the plain mount, and keeps a miss under it a missing file', async () => {
    app = site()
    await app.ready()

    expect((await app.fetch('/static/hello.txt')).status).toBe(200)
    await expectNotFoundJSON(await app.fetch('/static/missing.txt', { headers: NAVIGATION }))
  })

  it('does not answer outside its prefix', async () => {
    app = site()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/settings', { headers: NAVIGATION }))
  })
})
