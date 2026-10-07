import type { WebApplication } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CROSS_SITE, CURL, NAVIGATION, XHR, newApp, signIn } from '../util/testing/harness.js'

/**
 * CSRF protection by Fetch Metadata, on top of `SameSite=Lax` rather than instead of it.
 *
 * `Lax` is scoped to the site rather than the origin, exempts top-level `GET` navigations, and does nothing in a
 * client that does not enforce it. So every unsafe request is judged by what the browser says of where it came
 * from — `Sec-Fetch-Site`, then `Origin` — which no page can forge, and the client sends no token at all.
 */
describe('CSRF protection', () => {
  let app: WebApplication

  beforeAll(async () => {
    app = newApp()
    await app.bootstrap()
  })

  afterAll(async () => await app.close())

  function login(headers: Record<string, string>): Promise<Response> {
    return app.fetch('/auth/login', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user', password: 'user123' }),
    })
  }

  it('accepts a same-origin request, which carries nothing but what the browser sends anyway', async () => {
    expect((await login(XHR)).status).toBe(200)
  })

  // Login CSRF is a real attack, not a technicality: signing the victim into the attacker's account, so that
  // whatever the victim then enters lands there.
  it('refuses a form posted from another site, the login form included', async () => {
    const res = await login(CROSS_SITE)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'ERR_CSRF_CROSS_ORIGIN' })
  })

  it('refuses a browser without Fetch Metadata whose Origin is another site', async () => {
    const res = await login({ accept: 'application/json', origin: 'https://evil.example' })

    expect(res.status).toBe(403)
  })

  // Neither header is a client that is no browser, holding no victim's cookies: curl, a monitor, a script.
  it("accepts a request that is nobody's browser", async () => {
    expect((await login(CURL)).status).toBe(200)
  })

  it('never challenges a safe method', async () => {
    const crossSiteLink = { ...NAVIGATION, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }

    for (const path of ['/', '/login', '/livez']) {
      const res = await app.fetch(path, { headers: crossSiteLink })
      expect(res.status, path).not.toBe(403)
    }
  })

  // The case `Lax` waves through: a sibling subdomain is same-site, so the browser sends the session cookie with
  // its form post. The check refuses it, since same-site is not same-origin.
  it('refuses a form posted from a sibling subdomain, with the session cookie attached', async () => {
    const member = await signIn(app, 'user', 'user123')
    const res = await app.fetch('/auth/logout', {
      method: 'POST',
      headers: { ...CROSS_SITE, origin: 'http://blog.localhost', 'sec-fetch-site': 'same-site', cookie: member.cookie },
    })

    expect(res.status).toBe(403)
    // Refused before the handler ran: the session is still there.
    expect((await app.fetch('/auth/me', { headers: { ...XHR, cookie: member.cookie } })).status).toBe(200)
  })
})
