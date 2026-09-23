import { AuthenticationService, AuthenticationTicket, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { dist, expectNotFoundJSON, isolated, NAVIGATION, principal, SCRIPT, sessionCookie, XHR } from './_headers.js'

const SECRET = 'bff-session-secret-that-is-at-least-32-bytes!'

/**
 * A backend-for-frontend: the browser loads the shell from the same origin it calls `/api` on, signs in through
 * a route that persists a cookie session, and the application authenticates everything by default.
 */
function bff(gatedShell: boolean): WebApplication {
  const auth = newRouter('/auth')
    .authorize({ allowAnonymous: true })
    .inject({ auth: AuthenticationService })
    .post('/login', async (ctx, { auth }) => {
      const roles = ctx.req.header('x-roles')?.split(',') ?? []
      await auth.persist(ctx, 'Cookie', new AuthenticationTicket(principal('alice', roles, 'Cookie'), 'Cookie'))

      return { ok: true }
    })

  const api = newRouter('/api')
    .get('/me', ctx => ({ sub: ctx.user.findFirst('sub')?.value }))
    .mount(
      newRouter('/orders')
        .authorize({ roles: ['admin'] })
        .get('/', () => []),
    )

  return isolated()
    .authentication(a => a.addCookie(o => o.sessionSecret(SECRET).secure(false).loginPath('/login')))
    .authorization(z => z.requireAuthenticatedByDefault())
    .with(staticFiles(s => (gatedShell ? s.spa(dist, { authorize: {} }) : s.spa(dist))))
    .mount(auth, api) as WebApplication
}

async function signIn(app: WebApplication, roles = ''): Promise<string> {
  const res = await app.fetch('/auth/login', { method: 'POST', headers: { 'x-roles': roles } })
  expect(res.status).toBe(200)

  return sessionCookie(res)
}

describe('BFF: same-origin shell and /api, cookie session, authenticate by default', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  describe('public shell', () => {
    it('serves the shell to an anonymous navigation, even though the application authenticates by default', async () => {
      app = bff(false)
      await app.ready()

      for (const path of ['/', '/dashboard', '/orders/42']) {
        const res = await app.fetch(path, { headers: NAVIGATION })

        expect(res.status, path).toBe(200)
        expect(res.headers.get('content-type'), path).toMatch(/^text\/html/)
        expect(res.headers.get('cache-control'), path).toBe('no-cache')
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    // The shell's files are raw Fastify routes; without this they would fall under the fallback policy and the
    // public page would load with every script answering 401.
    it('serves the public shell’s assets anonymously', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    it('answers an anonymous fetch of the API with 401, not the shell', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/api/me', { headers: XHR })

      expect(res.status).toBe(401)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    it('redirects an anonymous navigation to the API into the login page', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/api/me', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      const location = res.headers.get('location') ?? ''
      expect(location.startsWith('/login?returnUrl=')).toBe(true)
      expect(decodeURIComponent(location)).toContain('/api/me')
    })

    it('authenticates the API through the session cookie', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      const res = await app.fetch('/api/me', { headers: { ...XHR, cookie } })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sub: 'alice' })
    })

    it('serves the shell to a signed-in navigation', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      const res = await app.fetch('/dashboard', { headers: { ...NAVIGATION, cookie } })

      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    })

    it('keeps an API miss a JSON 404, for a fetch and for a navigation alike', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...XHR, cookie } }))
      await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...NAVIGATION, cookie } }))
    })

    it('compares the path as the router did: decoded and with duplicate slashes collapsed', async () => {
      app = bff(false)
      await app.ready()

      await expectNotFoundJSON(await app.fetch('/%61pi/typo', { headers: NAVIGATION }))
      await expectNotFoundJSON(await app.fetch('//api//typo', { headers: NAVIGATION }))
    })

    it('renders a forbidden API call as an error, never as the page', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      const res = await app.fetch('/api/orders', { headers: { ...XHR, cookie } })

      expect(res.status).toBe(403)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    // The login page is a client-side route here: a shell gated by the fallback would redirect to itself.
    it('serves the client-side login page anonymously', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/login', { headers: NAVIGATION })

      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    })

    it('never answers a non-GET with a document', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      await expectNotFoundJSON(await app.fetch('/dashboard', { method: 'POST', headers: { ...NAVIGATION, cookie } }))
    })
  })

  describe('gated shell', () => {
    it('redirects an anonymous navigation to a client route into the login page', async () => {
      app = bff(true)
      await app.ready()

      const res = await app.fetch('/dashboard', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      const location = res.headers.get('location') ?? ''
      expect(location.startsWith('/login?returnUrl=')).toBe(true)
      expect(decodeURIComponent(location)).toContain('/dashboard')
    })

    it('gates the assets of a gated shell under the fallback policy', async () => {
      app = bff(true)
      await app.ready()

      const res = await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })

      expect(res.status).toBe(401)
    })

    it('serves the shell and its assets to a signed-in browser', async () => {
      app = bff(true)
      await app.ready()
      const cookie = await signIn(app)

      const page = await app.fetch('/dashboard', { headers: { ...NAVIGATION, cookie } })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<div id="root">')

      const asset = await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, cookie } })
      expect(asset.status).toBe(200)
    })

    it('challenges an anonymous fetch of a client route before asking whether it is a navigation', async () => {
      app = bff(true)
      await app.ready()

      const res = await app.fetch('/dashboard', { headers: XHR })

      expect(res.status).toBe(401)
    })
  })
})
