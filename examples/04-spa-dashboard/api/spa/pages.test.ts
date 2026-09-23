import type { WebApplication } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CURL,
  NAVIGATION,
  PROBE,
  SCRIPT,
  XHR,
  expectNotFoundJSON,
  newApp,
  signIn,
  type Session,
} from '../util/testing/harness.js'

/**
 * The single-page application: client routes, the bundle, and the two plugins in front of them.
 *
 * Everything here is asserted against the **real build output** — hashed names, root-level public files, and
 * the `.br`/`.gz` siblings `web/build.mjs` emits — rather than a hand-written fixture, because the parts most
 * easily got wrong (`preCompressed`, `globIgnore`, `immutableAssets`) only misbehave against a real one.
 */
describe('the single-page application', () => {
  let app: WebApplication
  let member: Session
  let admin: Session
  /** The hashed bundle URL, read out of the shell rather than hardcoded — the hash changes with the source. */
  let bundle: string

  beforeAll(async () => {
    app = newApp()
    await app.ready()
    member = await signIn(app, 'user', 'user123')
    admin = await signIn(app, 'admin', 'admin123')

    const shell = await (await app.fetch('/', { headers: NAVIGATION })).text()
    bundle = /src="([^"]+\.js)"/.exec(shell)?.[1] ?? ''
    expect(bundle, 'the shell must reference a hashed bundle').toMatch(/^\/assets\/.+\.js$/)
  })

  afterAll(async () => await app.close())

  describe('public client routes', () => {
    it('serves the shell anonymously, under authenticate-by-default', async () => {
      for (const path of ['/', '/index.html', '/about', '/login', '/forbidden', '/pricing']) {
        const res = await app.fetch(path, { headers: NAVIGATION })

        expect(res.status, path).toBe(200)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    // Gating either of these would loop: the sign-in page through itself, and the access-denied page through
    // a 403 that redirects to a page that redirects.
    it('never redirects the sign-in or access-denied pages', async () => {
      for (const path of ['/login', '/forbidden']) {
        expect((await app.fetch(path, { headers: NAVIGATION })).status, path).toBe(200)
      }
    })

    // A path the application declared answers any client — which is what a load balancer probe needs.
    it('answers a declared path to a client that is not a browser', async () => {
      for (const headers of [CURL, PROBE]) {
        expect((await app.fetch('/', { headers })).status).toBe(200)
        expect((await app.fetch('/index.html', { headers })).status).toBe(200)
      }
    })

    // A wildcard is a fallback, so it answers only a document request.
    it('does not answer a wildcard client route to a client that is not a browser', async () => {
      await expectNotFoundJSON(await app.fetch('/pricing', { headers: CURL }))
    })

    it('never answers a non-GET with a document', async () => {
      const res = await app.fetch('/pricing', { method: 'DELETE', headers: NAVIGATION })
      expect(res.status).not.toBe(200)
    })
  })

  describe('protected client routes', () => {
    it('redirects an anonymous navigation to sign in, carrying the return path', async () => {
      const res = await app.fetch('/dashboard/deep', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toBe('/login?returnUrl=/dashboard/deep')
    })

    it('answers an anonymous fetch of a protected route with 401, never a document', async () => {
      const res = await app.fetch('/dashboard', { headers: XHR })

      expect(res.status).toBe(401)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    it('serves the shell to a signed-in member across a subtree', async () => {
      for (const path of ['/dashboard', '/dashboard/settings', '/projects', '/projects/brew']) {
        const res = await app.fetch(path, { headers: { ...NAVIGATION, cookie: member.cookie } })

        expect(res.status, path).toBe(200)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    it('keeps the declared-versus-wildcard rule inside a protected tier', async () => {
      const declared = await app.fetch('/dashboard', { headers: { ...CURL, cookie: member.cookie } })
      expect(declared.status).toBe(200)

      await expectNotFoundJSON(await app.fetch('/dashboard/deep', { headers: { ...CURL, cookie: member.cookie } }))
    })

    // It matches `/*`, not `/dashboard`: an unknown client route is not a protected one.
    it('answers an unknown route near a protected one with the public shell', async () => {
      expect((await app.fetch('/dashboard-typo', { headers: NAVIGATION })).status).toBe(200)
    })
  })

  // The page half of fix F2. The API half is in projects.test.ts: one `accessDeniedPath`, two right answers.
  describe('a role-gated page', () => {
    it('sends a signed-in member to the access-denied page rather than the page they asked for', async () => {
      for (const path of ['/admin', '/admin/users']) {
        const res = await app.fetch(path, { headers: { ...NAVIGATION, cookie: member.cookie } })

        expect(res.status, path).toBe(302)
        expect(res.headers.get('location'), path).toBe('/forbidden')
      }
    })

    it('serves the page to an administrator', async () => {
      for (const path of ['/admin', '/admin/users']) {
        const res = await app.fetch(path, { headers: { ...NAVIGATION, cookie: admin.cookie } })

        expect(res.status, path).toBe(200)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })
  })

  describe('the bundle', () => {
    // One bundle serves the public and the protected routes alike, and the sign-in page needs it. This is
    // what `{ anonymous: true }` on the mount buys, and forgetting it renders the page while every script 401s.
    it('serves the assets anonymously even though client routes are gated', async () => {
      const res = await app.fetch(bundle, { headers: SCRIPT })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    // Same mount, different caching: the shell must be revalidated or a deploy never reaches anyone.
    it('does not pin the shell the way it pins the hashed assets', async () => {
      const res = await app.fetch('/', { headers: NAVIGATION })

      expect(res.headers.get('cache-control') ?? '').not.toContain('immutable')
    })

    it('keeps a missing asset a JSON 404 rather than a page', async () => {
      await expectNotFoundJSON(await app.fetch('/assets/missing-AAAAAAAA.js', { headers: NAVIGATION }))
    })

    // Each of these is its own route under `wildcard: false`; listing them by hand in the gate's `except`
    // would drift the moment the build emits another one.
    it('serves the root-level public files anonymously', async () => {
      for (const path of [
        '/favicon.svg',
        '/apple-touch-icon.svg',
        '/robots.txt',
        '/sitemap.xml',
        '/manifest.webmanifest',
      ]) {
        expect((await app.fetch(path, { headers: SCRIPT })).status, path).toBe(200)
      }
    })
  })

  describe('pre-compressed assets', () => {
    it('serves brotli to a client that accepts it', async () => {
      const res = await app.fetch(bundle, { headers: { ...SCRIPT, 'accept-encoding': 'br' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe('br')
      expect(res.headers.get('vary') ?? '').toContain('accept-encoding')
      expect(res.headers.get('content-type') ?? '').toContain('javascript')
    })

    it('falls back to gzip, and to the identity bytes', async () => {
      const gzip = await app.fetch(bundle, { headers: { ...SCRIPT, 'accept-encoding': 'gzip' } })
      expect(gzip.headers.get('content-encoding')).toBe('gzip')

      const plain = await app.fetch(bundle, { headers: SCRIPT })
      expect(plain.headers.get('content-encoding')).toBeNull()
    })

    // `sendFile` reads `preCompressed` off the plugin's registration closure, so a compiled route serving the
    // shell gets it without asking for it.
    it('compresses the shell served from a compiled route', async () => {
      const res = await app.fetch('/', { headers: { ...NAVIGATION, 'accept-encoding': 'br' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe('br')
      expect(res.headers.get('content-type') ?? '').toContain('text/html')
    })

    // What `spaMount()`'s globIgnore is for: reachable as its own URL, this would answer with raw brotli under
    // application/octet-stream and no content-encoding.
    it('does not expose the compressed siblings as URLs of their own', async () => {
      for (const suffix of ['.br', '.gz']) {
        await expectNotFoundJSON(await app.fetch(`${bundle}${suffix}`, { headers: NAVIGATION }))
      }
    })
  })

  describe('security headers', () => {
    it('sets a content security policy the bundle loads under', async () => {
      const res = await app.fetch('/', { headers: NAVIGATION })
      const csp = res.headers.get('content-security-policy') ?? ''

      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("connect-src 'self'")
      // Turned off deliberately: over plain http it would rewrite every subresource to https.
      expect(csp).not.toContain('upgrade-insecure-requests')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    })

    // Registered before the authentication gate, which is the only reason they reach a rejected request.
    it('sets them on a challenge as well as on a page', async () => {
      const res = await app.fetch('/api/profile', { headers: XHR })

      expect(res.status).toBe(401)
      expect(res.headers.get('content-security-policy') ?? '').toContain("default-src 'self'")
    })
  })

  describe('the OpenAPI document', () => {
    it('describes the API and not the client routes', async () => {
      const res = await app.fetch('/openapi.json', { headers: { ...XHR, cookie: admin.cookie } })
      expect(res.status).toBe(200)

      const paths = Object.keys(((await res.json()) as { paths: Record<string, unknown> }).paths)

      expect(paths).toEqual(expect.arrayContaining(['/api/profile', '/api/projects', '/api/admin/users']))
      // `detail('http', { internal: true })` on every client-route router keeps documents out of a document
      // describing operations.
      for (const path of ['/*', '/dashboard', '/admin', '/login']) {
        expect(paths, path).not.toContain(path)
      }
    })
  })
})
