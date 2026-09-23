import { newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { sendFile, spaMount, staticFiles } from '../../index.js'
import {
  admin as adminDist,
  clientRouteOf,
  dist,
  expectNotFoundJSON,
  HeaderAuthenticationHandler,
  isolated,
  NAVIGATION,
  notFound,
  SCRIPT,
  shellOf,
  XHR,
} from './_headers.js'

/**
 * A public customer application at `/` and an administration application at `/admin`, one origin.
 *
 * Nothing coordinates the two: `/admin/*` beats `/*` by static-prefix length, so they are ordinary routes
 * that happen to be neighbours. The public bundle is anonymous because the sign-in page needs it; the
 * administration bundle is served from a compiled route, so it carries the same role as its page.
 */
function origin(authenticateByDefault: boolean): WebApplication {
  const app = isolated()
    .authentication(a => a.addStrategy('header', new HeaderAuthenticationHandler()))
    .with(staticFiles(s => s.serve(dist, spaMount(), { anonymous: true }).serve(adminDist, { serve: false })))
    .mount(
      newRouter('/api')
        .get('/pets', () => ({ pets: [] }))
        .get('/*', notFound),
      newRouter()
        .detail('http', { internal: true })
        .authorize({ allowAnonymous: true })
        .get('/', shellOf(dist))
        .get('/index.html', shellOf(dist))
        .get('/*', clientRouteOf(dist)),
      newRouter()
        .detail('http', { internal: true })
        .authorize({ roles: ['admin'] })
        .get('/admin', shellOf(adminDist))
        .get('/admin/assets/*', ctx => sendFile(ctx, ctx.req.url.split('?', 1)[0]!.slice('/admin'.length), adminDist))
        .get('/admin/*', clientRouteOf(adminDist)),
    ) as WebApplication

  if (authenticateByDefault) {
    app.authorization(z => z.requireAuthenticatedByDefault())
  }

  return app
}

const bob = { 'x-user': 'bob' }
const ann = { 'x-user': 'ann', 'x-roles': 'admin' }

describe('two applications on one origin', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('serves the public application to anyone at the root', async () => {
    app = origin(false)
    await app.ready()

    const res = await app.fetch('/settings', { headers: NAVIGATION })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('refuses the administration application to a stranger and to a user without the role', async () => {
    app = origin(false)
    await app.ready()

    expect((await app.fetch('/admin/users', { headers: NAVIGATION })).status).toBe(401)

    const forbidden = await app.fetch('/admin/users', { headers: { ...NAVIGATION, ...bob } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
  })

  it('serves the administration application, and only that one, under its prefix', async () => {
    app = origin(false)
    await app.ready()

    for (const path of ['/admin', '/admin/', '/admin/users']) {
      const res = await app.fetch(path, { headers: { ...NAVIGATION, ...ann } })

      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain('<div id="admin-root">')
    }
  })

  it('answers a missing file under the administration prefix as a 404', async () => {
    app = origin(false)
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/admin/missing.js', { headers: { ...NAVIGATION, ...ann } }))
  })

  // One bundle is public because its sign-in page needs it; the other is as gated as the page it belongs to.
  it('serves the public bundle to anyone and the administration bundle only to an administrator', async () => {
    app = origin(true)
    await app.ready()

    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })).status).toBe(200)
    expect((await app.fetch('/admin/assets/admin-Zz9.js', { headers: SCRIPT })).status).toBe(401)
    expect((await app.fetch('/admin/assets/admin-Zz9.js', { headers: { ...SCRIPT, ...bob } })).status).toBe(403)

    const allowed = await app.fetch('/admin/assets/admin-Zz9.js', { headers: { ...SCRIPT, ...ann } })
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('admin bundle')
  })

  it('keeps an API miss a JSON 404 whichever application it is nearest to', async () => {
    app = origin(false)
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/api/typo', { headers: XHR }))
  })
})
