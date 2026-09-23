import { newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrDuplicateSPAMount, staticFiles } from '../../index.js'
import {
  admin,
  dist,
  expectNotFoundJSON,
  HeaderAuthenticationHandler,
  isolated,
  NAVIGATION,
  noShell,
  SCRIPT,
  XHR,
} from './_headers.js'

/** A public customer application at `/` and an administration application at `/admin`, one origin. */
function origin(authenticateByDefault: boolean): WebApplication {
  const app = isolated()
    .authentication(a => a.addStrategy('header', new HeaderAuthenticationHandler()))
    .with(staticFiles(s => s.spa(dist).spa(admin, { prefix: '/admin', authorize: { roles: ['admin'] } })))
    .mount(newRouter('/api').get('/pets', () => ({ pets: [] }))) as WebApplication

  if (authenticateByDefault) {
    app.authorization(z => z.requireAuthenticatedByDefault())
  }

  return app
}

const bob = { 'x-user': 'bob' }
const ann = { 'x-user': 'ann', 'x-roles': 'admin' }

describe('two shells on one origin', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  it('serves the public shell to anyone at the root', async () => {
    app = origin(false)
    await app.ready()

    const res = await app.fetch('/settings', { headers: NAVIGATION })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('refuses the administration shell to a stranger and to a user without the role', async () => {
    app = origin(false)
    await app.ready()

    expect((await app.fetch('/admin/users', { headers: NAVIGATION })).status).toBe(401)

    const forbidden = await app.fetch('/admin/users', { headers: { ...NAVIGATION, ...bob } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
  })

  it('serves the administration shell, and only that one, to an administrator under its prefix', async () => {
    app = origin(false)
    await app.ready()

    for (const path of ['/admin', '/admin/', '/admin/users']) {
      const res = await app.fetch(path, { headers: { ...NAVIGATION, ...ann } })

      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain('<div id="admin-root">')
    }
  })

  it('answers a missing file under the administration prefix from that shell, as a 404', async () => {
    app = origin(false)
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/admin/missing.js', { headers: { ...NAVIGATION, ...ann } }))
  })

  it('exempts the public shell’s assets and leaves the gated shell’s to the fallback policy', async () => {
    app = origin(false)
    await app.ready()
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })).status).toBe(200)
    expect((await app.fetch('/admin/assets/admin-Zz9.js', { headers: SCRIPT })).status).toBe(200)
    await app.close()

    app = origin(true)
    await app.ready()
    expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })).status).toBe(200)
    expect((await app.fetch('/admin/assets/admin-Zz9.js', { headers: SCRIPT })).status).toBe(401)
  })

  it('keeps an API miss a JSON 404 whichever shell it is nearest to', async () => {
    app = origin(false)
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/api/typo', { headers: XHR }))
  })

  it('refuses two shells at one prefix', async () => {
    app = isolated().with(staticFiles(s => s.spa(dist).spa(admin))) as WebApplication

    await expect(app.ready()).rejects.toThrow(ErrDuplicateSPAMount)
  })

  // The administration site was not built: its prefix is inert, and the public shell's wildcard covers it.
  it('lets the root shell cover a prefix whose shell was skipped', async () => {
    app = isolated().with(
      staticFiles(s => s.spa(dist).spa(noShell, { prefix: '/admin', onMissingIndex: 'skip' })),
    ) as WebApplication
    await app.ready()

    expect(await (await app.fetch('/settings', { headers: NAVIGATION })).text()).toContain('<div id="root">')
    expect(await (await app.fetch('/admin/users', { headers: NAVIGATION })).text()).toContain('<div id="root">')
  })
})
