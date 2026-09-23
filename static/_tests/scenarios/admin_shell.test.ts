import { newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { sendFile, staticFiles } from '../../index.js'
import {
  clientRouteOf,
  dist,
  expectNotFoundJSON,
  HeaderAuthenticationHandler,
  isolated,
  NAVIGATION,
  SCRIPT,
  shellOf,
  XHR,
} from './_headers.js'

/**
 * An administration site where the page *and* its bundle are for administrators.
 *
 * There is deliberately no `@fastify/static` mount: its file routes are raw Fastify routes, which carry no
 * authorization of their own and fall to the application's fallback policy — so the bundle of a role-gated
 * site would be readable by anyone, or by any signed-in user. Serving the files from a compiled route instead
 * puts every byte behind the same `authorize` as the page. `sendFile` still goes through `@fastify/static`,
 * so the `..` and non-canonical-path guards apply.
 *
 * `serve: false` is what makes that possible: the mount registers no routes at all, and exists only to
 * decorate the reply and to name the root `sendFile` resolves against.
 */
function adminSite(authenticateByDefault: boolean): WebApplication {
  const app = isolated()
    .authentication(a => a.addStrategy('header', new HeaderAuthenticationHandler()))
    .with(staticFiles(s => s.serve(dist, { serve: false })))
    .mount(
      newRouter('/api')
        .authorize({ roles: ['admin'] })
        .get('/report', () => ({ rows: [] })),
      newRouter()
        .detail('http', { internal: true })
        .authorize({ roles: ['admin'] })
        .get('/', shellOf(dist))
        .get('/index.html', shellOf(dist))
        .get('/assets/*', ctx => sendFile(ctx, ctx.req.url.split('?', 1)[0]!, dist))
        .get('/*', clientRouteOf(dist)),
    ) as WebApplication

  if (authenticateByDefault) {
    app.authorization(z => z.requireAuthenticatedByDefault())
  }

  return app
}

const anonymous = {}
const bob = { 'x-user': 'bob' }
const ann = { 'x-user': 'ann', 'x-roles': 'admin' }

describe('role-gated administration site', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it.each([
    ['anonymous', anonymous, 401],
    ['a user without the role', bob, 403],
  ] as const)('refuses the page to %s with %i, not with a page', async (_who, caller, status) => {
    app = adminSite(false)
    await app.ready()

    const page = await app.fetch('/', { headers: { ...NAVIGATION, ...caller } })
    expect(page.status).toBe(status)
    expect(page.headers.get('content-type') ?? '').not.toMatch(/text\/html/)

    const report = await app.fetch('/api/report', { headers: { ...XHR, ...caller } })
    expect(report.status).toBe(status)
  })

  it('serves the page and the API to an administrator', async () => {
    app = adminSite(false)
    await app.ready()

    const page = await app.fetch('/', { headers: { ...NAVIGATION, ...ann } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')

    expect((await app.fetch('/api/report', { headers: { ...XHR, ...ann } })).status).toBe(200)
  })

  // The whole point of serving the files from a compiled route: the bundle is as gated as the page it loads,
  // with no fallback policy configured and nothing exempted.
  it.each([
    ['anonymous', anonymous, 401],
    ['a user without the role', bob, 403],
  ] as const)('refuses the bundle to %s with %i', async (_who, caller, status) => {
    app = adminSite(false)
    await app.ready()

    const res = await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, ...caller } })
    expect(res.status).toBe(status)
  })

  it('serves the bundle to an administrator', async () => {
    app = adminSite(false)
    await app.ready()

    const res = await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, ...ann } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('spa bundle')
  })

  it('keeps a missing asset a JSON 404 for an administrator', async () => {
    app = adminSite(false)
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/assets/missing.js', { headers: { ...SCRIPT, ...ann } }))
  })

  it('stays gated under authenticate-by-default', async () => {
    app = adminSite(true)
    await app.ready()

    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })).status).toBe(401)
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, ...bob } })).status).toBe(403)
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, ...ann } })).status).toBe(200)
  })
})
