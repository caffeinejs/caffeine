import type { WebApplication } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CSRF_COOKIE } from '../app.config.js'
import { XHR, anonymousSession, newApp, signIn } from '../util/testing/harness.js'

/**
 * CSRF, on top of `SameSite=Lax` rather than instead of it.
 *
 * `Lax` is scoped to the site rather than the origin, exempts top-level `GET` navigations, and does nothing
 * in a client that does not enforce it — so unsafe methods carry a token as well.
 */
describe('CSRF protection', () => {
  let app: WebApplication

  beforeAll(async () => {
    app = newApp()
    await app.ready()
  })

  afterAll(async () => await app.close())

  async function login(session: { cookie: string; csrf?: string }, token?: string): Promise<Response> {
    return app.fetch('/auth/login', {
      method: 'POST',
      headers: {
        ...XHR,
        'content-type': 'application/json',
        cookie: session.cookie,
        ...(token === undefined ? {} : { 'x-csrf-token': token }),
      },
      body: JSON.stringify({ username: 'user', password: 'user123' }),
    })
  }

  // Two different refusals, and which one you get says where the request went wrong.
  it('refuses an unsafe request that carries no token', async () => {
    const anon = await anonymousSession(app)
    const res = await login(anon)

    expect(res.status).toBe(403)
    // The secret cookie is there; nothing was presented against it.
    expect(await res.json()).toMatchObject({ code: 'FST_CSRF_INVALID_TOKEN' })
  })

  it('refuses an unsafe request from a client that never asked for a token', async () => {
    const res = await login({ cookie: '' }, 'invented')

    expect(res.status).toBe(403)
    // No `_csrf` cookie at all, so there is nothing to verify against.
    expect(await res.json()).toMatchObject({ code: 'FST_CSRF_MISSING_SECRET' })
  })

  it('refuses a token that does not match the secret cookie', async () => {
    const anon = await anonymousSession(app)
    const other = await anonymousSession(app)

    // `other`'s token was minted against `other`'s secret, so it is worthless here.
    const res = await login(anon, other.csrf)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'FST_CSRF_INVALID_TOKEN' })
  })

  it('accepts a token minted against the cookie that is sent with it', async () => {
    const anon = await anonymousSession(app)

    expect((await login(anon, anon.csrf)).status).toBe(200)
  })

  // The check is an `onRequest` hook with a method filter of its own: without it every GET, the shell
  // included, would be refused.
  it('never challenges a safe method', async () => {
    for (const path of ['/', '/login', '/auth/csrf', '/livez']) {
      const res = await app.fetch(path, { headers: XHR })
      expect(res.status, path).not.toBe(403)
    }
  })

  // Rotating at the session boundary is the point: a token minted before sign-in must not survive it.
  it('rotates the secret when a session begins', async () => {
    const anon = await anonymousSession(app)
    const before = anon.csrf

    const res = await login(anon, before)
    expect(res.status).toBe(200)

    const { csrfToken } = (await res.json()) as { csrfToken: string }
    expect(csrfToken).not.toBe(before)

    const cookie = res.headers.getSetCookie().find(line => line.startsWith(`${CSRF_COOKIE}=`))
    expect(cookie, 'signing in must issue a new CSRF secret, not merely clear the old one').toBeDefined()
  })

  it('leaves the token that opened the session unusable afterwards', async () => {
    const anon = await anonymousSession(app)
    const stale = anon.csrf

    const res = await login(anon, stale)
    const cookies = res.headers.getSetCookie().map(line => line.split(';', 1)[0]!)

    const rotated = await app.fetch('/auth/logout', {
      method: 'POST',
      headers: { ...XHR, 'x-csrf-token': stale, cookie: cookies.join('; ') },
    })

    expect(rotated.status).toBe(403)
  })

  // The cookie scheme's `revoke` clears its own cookie and knows nothing about any other plugin's, so without
  // the route doing it the secret would outlive the session and be inherited by the next user of this browser.
  it('clears the secret on sign-out', async () => {
    const member = await signIn(app, 'user', 'user123')

    const out = await app.fetch('/auth/logout', {
      method: 'POST',
      headers: { ...XHR, 'x-csrf-token': member.csrf, cookie: member.cookie },
    })

    expect(out.status).toBe(200)
    expect((await out.json()) as { csrfToken: string }).toHaveProperty('csrfToken')
  })
})
