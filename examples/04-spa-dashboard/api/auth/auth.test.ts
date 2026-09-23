import type { WebApplication } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SESSION_COOKIE } from '../app.config.js'
import { NAVIGATION, XHR, anonymousSession, newApp, signIn } from '../util/testing/harness.js'

/**
 * One scheme, for the pages and for the API.
 *
 * The thing under test is not "can a user log in" but the split that lets a single-page application and its
 * API share a scheme: the same refusal is a redirect for a browser and a status for everything else.
 */
describe('cookie authentication', () => {
  let app: WebApplication

  beforeAll(async () => {
    app = newApp()
    await app.ready()
  })

  afterAll(async () => await app.close())

  describe('signing in', () => {
    it('accepts the demo accounts and reports the principal', async () => {
      const member = await signIn(app, 'user', 'user123')
      const me = await app.fetch('/auth/me', { headers: { ...XHR, cookie: member.cookie } })

      expect(me.status).toBe(200)
      expect(await me.json()).toEqual({ sub: 'user', name: 'Ulric User', roles: ['member'] })
    })

    it('carries the roles that gate the admin routes', async () => {
      const admin = await signIn(app, 'admin', 'admin123')
      const me = await app.fetch('/auth/me', { headers: { ...XHR, cookie: admin.cookie } })

      expect(await me.json()).toEqual({ sub: 'admin', name: 'Ada Admin', roles: ['admin', 'member'] })
    })

    it('refuses a wrong password without saying which half was wrong', async () => {
      const anon = await anonymousSession(app)
      const res = await app.fetch('/auth/login', {
        method: 'POST',
        headers: { ...XHR, 'content-type': 'application/json', 'x-csrf-token': anon.csrf, cookie: anon.cookie },
        body: JSON.stringify({ username: 'user', password: 'wrong' }),
      })

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ ok: false })
    })

    // `persist` writes the cookie for the *next* request; it does not re-authenticate this one. The response
    // therefore describes what was just verified, not `ctx.user` — which is still anonymous here.
    it('describes the principal in the login response itself', async () => {
      const anon = await anonymousSession(app)
      const res = await app.fetch('/auth/login', {
        method: 'POST',
        headers: { ...XHR, 'content-type': 'application/json', 'x-csrf-token': anon.csrf, cookie: anon.cookie },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      })

      const body = (await res.json()) as { ok: boolean; user: { name: string } }
      expect(body.ok).toBe(true)
      expect(body.user.name).toBe('Ada Admin')
    })
  })

  describe('the session cookie', () => {
    it('is HttpOnly, SameSite=Lax and path-wide', async () => {
      const anon = await anonymousSession(app)
      const res = await app.fetch('/auth/login', {
        method: 'POST',
        headers: { ...XHR, 'content-type': 'application/json', 'x-csrf-token': anon.csrf, cookie: anon.cookie },
        body: JSON.stringify({ username: 'user', password: 'user123' }),
      })

      const set = res.headers.getSetCookie().find(line => line.startsWith(`${SESSION_COOKIE}=`))
      expect(set).toBeDefined()
      expect(set).toMatch(/HttpOnly/i)
      expect(set).toMatch(/SameSite=Lax/i)
      expect(set).toMatch(/Path=\//i)
    })

    // Encrypted, not merely signed: the claims must not be readable by whoever holds the cookie.
    it('does not expose the claims to anyone holding it', async () => {
      const member = await signIn(app, 'user', 'user123')
      const value = /spa\.session=([^;]+)/.exec(member.cookie)?.[1] ?? ''

      expect(value).not.toBe('')
      expect(decodeURIComponent(value)).not.toContain('Ulric')
      expect(decodeURIComponent(value)).not.toContain('member')
    })

    it('treats a tampered cookie as anonymous rather than erroring', async () => {
      const res = await app.fetch('/auth/me', { headers: { ...XHR, cookie: `${SESSION_COOKIE}=not-a-real-session` } })

      expect(res.status).toBe(401)
    })
  })

  // The reason one scheme can serve both halves.
  describe('the challenge adapts to the caller', () => {
    it('redirects a browser navigation to the sign-in page, carrying the return path', async () => {
      const res = await app.fetch('/dashboard', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?returnUrl=%2Fdashboard')
    })

    it('answers a fetch with 401 and never a document', async () => {
      const res = await app.fetch('/api/profile', { headers: XHR })

      expect(res.status).toBe(401)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })
  })

  describe('signing out', () => {
    it('ends the session', async () => {
      const member = await signIn(app, 'user', 'user123')

      const out = await app.fetch('/auth/logout', {
        method: 'POST',
        headers: { ...XHR, 'x-csrf-token': member.csrf, cookie: member.cookie },
      })
      expect(out.status).toBe(200)

      // The session cookie is cleared, so what the browser would send back no longer authenticates.
      const cleared = out.headers.getSetCookie().some(line => line.startsWith(`${SESSION_COOKIE}=;`))
      expect(cleared).toBe(true)
    })

    // Anonymous, so that signing out twice — or from a tab whose session already expired — is not a 401.
    it('is anonymous', async () => {
      const anon = await anonymousSession(app)
      const res = await app.fetch('/auth/logout', {
        method: 'POST',
        headers: { ...XHR, 'x-csrf-token': anon.csrf, cookie: anon.cookie },
      })

      expect(res.status).toBe(200)
    })
  })
})
