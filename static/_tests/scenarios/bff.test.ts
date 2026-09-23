import { AuthenticationService, AuthenticationTicket, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { immutableAssets, spaMount, staticFiles } from '../../index.js'
import {
  clientRouteOf,
  dist,
  expectNotFoundJSON,
  isolated,
  NAVIGATION,
  notFound,
  principal,
  SCRIPT,
  sessionCookie,
  shellOf,
  XHR,
} from './_headers.js'

const SECRET = 'bff-session-secret-that-is-at-least-32-bytes!'

/**
 * A backend-for-frontend: the browser loads the page from the same origin it calls `/api` on, signs in
 * through a route that persists a cookie session, and the application authenticates everything by default.
 *
 * `gatedPages` is the whole difference between the two postures, and it is one `authorize` on the
 * application's own router — not a setting the static plugin knows about.
 */
function bff(gatedPages: boolean): WebApplication {
  const auth = newRouter('/auth')
    .authorize({ allowAnonymous: true })
    .inject({ service: AuthenticationService })
    .post('/login', async (ctx, { service }) => {
      const roles = ctx.req.header('x-roles')?.split(',').filter(Boolean) ?? []
      await service.persist(ctx, 'Cookie', new AuthenticationTicket(principal('alice', roles, 'Cookie'), 'Cookie'))

      return { ok: true }
    })

  const api = newRouter('/api')
    .get('/me', ctx => ({ sub: ctx.user.findFirst('sub')?.value }))
    .mount(
      newRouter('/orders')
        .authorize({ roles: ['admin'] })
        .get('/', () => []),
    )
    .get('/*', notFound)

  const pages = newRouter()
    .detail('http', { internal: true })
    .authorize(gatedPages ? {} : { allowAnonymous: true })
    .get('/', shellOf(dist))
    .get('/index.html', shellOf(dist))

  // The sign-in page is a client route, so it stays anonymous whichever posture the rest takes: a gated
  // login page redirects to itself.
  const signIn = newRouter()
    .detail('http', { internal: true })
    .authorize({ allowAnonymous: true })
    .get('/login', shellOf(dist))

  const rest = newRouter()
    .detail('http', { internal: true })
    .authorize(gatedPages ? {} : { allowAnonymous: true })
    .get('/*', clientRouteOf(dist))

  return isolated()
    .authentication(a => a.addCookie(o => o.sessionSecret(SECRET).secure(false).loginPath('/login')))
    .authorization(z => z.requireAuthenticatedByDefault())
    .with(staticFiles(s => s.serve(dist, { ...spaMount(), setHeaders: immutableAssets(dist) }, { anonymous: true })))
    .mount(auth, api, signIn, pages, rest) as WebApplication
}

async function signIn(app: WebApplication, roles = ''): Promise<string> {
  const res = await app.fetch('/auth/login', { method: 'POST', headers: { 'x-roles': roles } })
  expect(res.status).toBe(200)

  return sessionCookie(res)
}

describe('backend-for-frontend: same-origin page and /api, cookie session, authenticate by default', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  describe('public pages', () => {
    it('serves the page to an anonymous navigation, though the application authenticates by default', async () => {
      app = bff(false)
      await app.ready()

      for (const path of ['/', '/dashboard', '/orders/42']) {
        const res = await app.fetch(path, { headers: NAVIGATION })

        expect(res.status, path).toBe(200)
        expect(res.headers.get('content-type'), path).toMatch(/^text\/html/)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    // Without `{ anonymous: true }` on the mount these would answer 401 under the fallback policy, and the
    // public page would load with every script failing.
    it('serves the bundle anonymously', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    it('answers an anonymous fetch of the API with 401, not the page', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/api/me', { headers: XHR })

      expect(res.status).toBe(401)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    it('redirects an anonymous navigation to the API into the sign-in page', async () => {
      app = bff(false)
      await app.ready()

      const res = await app.fetch('/api/me', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      expect((res.headers.get('location') ?? '').startsWith('/login?returnUrl=')).toBe(true)
    })

    it('authenticates the API through the session cookie', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      const res = await app.fetch('/api/me', { headers: { ...XHR, cookie } })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sub: 'alice' })
    })

    it('keeps an API miss a JSON 404, for a fetch and for a navigation alike', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...XHR, cookie } }))
      await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...NAVIGATION, cookie } }))
    })

    it('renders a forbidden API call as an error, never as the page', async () => {
      app = bff(false)
      await app.ready()
      const cookie = await signIn(app)

      const res = await app.fetch('/api/orders', { headers: { ...XHR, cookie } })

      expect(res.status).toBe(403)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    it('serves the client-side sign-in page anonymously', async () => {
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

  describe('gated pages', () => {
    it('redirects an anonymous navigation to a client route into the sign-in page', async () => {
      app = bff(true)
      await app.ready()

      const res = await app.fetch('/dashboard', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      const location = res.headers.get('location') ?? ''
      expect(location.startsWith('/login?returnUrl=')).toBe(true)
      expect(decodeURIComponent(location)).toContain('/dashboard')
    })

    it('keeps the sign-in page reachable so the redirect does not loop', async () => {
      app = bff(true)
      await app.ready()

      expect((await app.fetch('/login', { headers: NAVIGATION })).status).toBe(200)
    })

    it('serves the page and its bundle to a signed-in browser', async () => {
      app = bff(true)
      await app.ready()
      const cookie = await signIn(app)

      const page = await app.fetch('/dashboard', { headers: { ...NAVIGATION, cookie } })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<div id="root">')

      expect((await app.fetch('/assets/app-eZr2sdaR.js', { headers: { ...SCRIPT, cookie } })).status).toBe(200)
    })

    it('challenges an anonymous fetch of a client route before asking whether it is a navigation', async () => {
      app = bff(true)
      await app.ready()

      expect((await app.fetch('/dashboard', { headers: XHR })).status).toBe(401)
    })
  })
})
