import { newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { dist, HeaderAuthenticationHandler, isolated, NAVIGATION, SCRIPT, XHR } from './_headers.js'

/** An administration site: the page itself is for administrators, and so is its API. */
function adminSite(authenticateByDefault: boolean): WebApplication {
  const api = newRouter('/api')
    .authorize({ roles: ['admin'] })
    .get('/report', () => ({ rows: [] }))

  const app = isolated()
    .authentication(a => a.addStrategy('header', new HeaderAuthenticationHandler()))
    .with(staticFiles(s => s.spa(dist, { authorize: { roles: ['admin'] } })))
    .mount(api) as WebApplication

  if (authenticateByDefault) {
    app.authorization(z => z.requireAuthenticatedByDefault())
  }

  return app
}

const anonymous = {}
const bob = { 'x-user': 'bob' }
const ann = { 'x-user': 'ann', 'x-roles': 'admin' }

describe('role-gated administration shell', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it.each([
    ['anonymous', anonymous, 401],
    ['a user without the role', bob, 403],
  ] as const)('refuses the shell to %s with %i, not with a page', async (_who, caller, status) => {
    app = adminSite(false)
    await app.ready()

    const page = await app.fetch('/', { headers: { ...NAVIGATION, ...caller } })
    expect(page.status).toBe(status)
    expect(page.headers.get('content-type') ?? '').not.toMatch(/text\/html/)

    const report = await app.fetch('/api/report', { headers: { ...XHR, ...caller } })
    expect(report.status).toBe(status)
  })

  it('serves the shell and the API to an administrator', async () => {
    app = adminSite(false)
    await app.ready()

    const page = await app.fetch('/', { headers: { ...NAVIGATION, ...ann } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')

    const report = await app.fetch('/api/report', { headers: { ...XHR, ...ann } })
    expect(report.status).toBe(200)
  })

  // A gated shell's files are not exempted: they answer whatever the application's fallback policy says, which
  // with no fallback policy is "anyone", and with authenticate-by-default is 401 for a stranger.
  it('leaves a gated shell’s assets to the fallback policy', async () => {
    app = adminSite(false)
    await app.ready()
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })).status).toBe(200)
    await app.close()

    app = adminSite(true)
    await app.ready()
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })).status).toBe(401)
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, ...bob } })).status).toBe(200)
  })
})
