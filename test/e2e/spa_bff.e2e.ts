import { fileURLToPath } from 'node:url'

import { ErrHTTPNotFound, newRouter, type Context } from '@caffeinejs/http'
import { isDocumentRequest, sendFile, spaMount, staticFiles } from '@caffeinejs/static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser } from './internal/browser/index.js'
import { startStubProvider, type StubProvider } from './internal/stub_provider.js'

// The redirect URI is part of the client's registration, so the port is fixed for the file.
const PORT = 9977
const ORIGIN = `http://localhost:${PORT}`
const SESSION_SECRET = 'spa-bff-e2e-session-secret-of-32-bytes!!'
const dist = fileURLToPath(new URL('../../static/_tests/_testdata/spa', import.meta.url))

const SCRIPT = { accept: '*/*', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }

const shellDocument = (ctx: Context) => sendFile(ctx, 'index.html', dist)
const notFound = (ctx: Context): never => {
  throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
}
const clientRoute = (ctx: Context) => (isDocumentRequest(ctx) ? shellDocument(ctx) : notFound(ctx))

/** The client routes, public or behind the provider, which is one `authorize` and nothing else. */
function pages(gated: boolean) {
  return newRouter()
    .detail('http', { internal: true })
    .authorize(gated ? {} : { allowAnonymous: true })
    .get('/', shellDocument)
    .get('/index.html', shellDocument)
    .get('/*', clientRoute)
}

/**
 * The built site.
 *
 * Public: an ordinary mount whose files are anonymous, because the page that has not signed in yet still has
 * to load its scripts. Gated: no file routes at all (`serve: false` leaves only the decoration), and the
 * bundle is served from a compiled route carrying the same policy as the page.
 */
function site(gated: boolean) {
  return gated
    ? staticFiles(s => s.serve(dist, { serve: false }))
    : staticFiles(s => s.serve(dist, spaMount(), { anonymous: true }))
}

function assets() {
  return newRouter()
    .detail('http', { internal: true })
    .authorize({})
    .get('/assets/*', ctx => sendFile(ctx, ctx.req.url.split('?', 1)[0]!, dist))
}

function api() {
  return (
    newRouter('/api')
      .get('/me', ctx => Object.fromEntries(ctx.user.claims().map(claim => [claim.type, claim.value])))
      .mount(
        newRouter('/admin')
          .authorize({ roles: ['admin'] })
          .get('/', () => ({ ok: true })),
      )
      // The API owns its own misses, so a browser navigating to `/api/typo` never reaches the client routes.
      .get('/*', notFound)
  )
}

/**
 * A backend-for-frontend over a real socket: the browser lands on a client route, is sent through the identity
 * provider, comes back with a session cookie, and the page and its API calls follow from there.
 */
async function bff(provider: StubProvider, gatedShell: boolean): Promise<RunningApp> {
  return startApp(
    app => {
      const configured = app
        .authentication(auth =>
          auth.addOAuth2('stub', o =>
            o
              .clientID('spa-bff')
              .clientSecret('spa-bff-secret')
              .sessionSecret(SESSION_SECRET)
              .callbackURL(`${ORIGIN}/oauth2/callback`)
              .authorizationEndpoint(`${provider.origin}/authorize`)
              .tokenEndpoint(`${provider.origin}/token`)
              .userInfoEndpoint(`${provider.origin}/userinfo`)
              .subjectClaim('sub')
              .defaultRedirectPath('/dashboard'),
          ),
        )
        .authorization(z => z.requireAuthenticatedByDefault())
        .with(site(gatedShell))

      // A gated site serves its own bundle from a compiled route, so the assets carry the page's policy.
      return gatedShell ? configured.mount(api(), assets(), pages(true)) : configured.mount(api(), pages(false))
    },
    { port: PORT },
  )
}

describe('BFF: a browser signs in through the provider and lands on the shell', () => {
  let provider: StubProvider

  beforeAll(async () => {
    provider = await startStubProvider({ sub: 'user-42', name: 'Ann' })
  })

  afterAll(async () => {
    await provider.close()
  })

  describe('gated shell', () => {
    let running: RunningApp
    const browser = new Browser()

    beforeAll(async () => {
      running = await bff(provider, true)
    })

    afterAll(async () => {
      await running.close()
    })

    it('sends an anonymous navigation through the provider and back to the page', async () => {
      const page = await browser.navigate(`${ORIGIN}/dashboard`)

      expect(page.hops[0]).toMatchObject({ url: `${ORIGIN}/dashboard`, status: 302 })
      expect(page.hops[0].location).toContain(`${provider.origin}/authorize`)
      expect(page.hops.some(hop => hop.url.startsWith(`${ORIGIN}/oauth2/callback?`))).toBe(true)
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toMatch(/^text\/html/)
      expect(page.text()).toContain('<div id="root">')
      expect(await browser.cookieLike(ORIGIN, 'session')).toBeDefined()
    })

    it('authenticates the API through the session', async () => {
      const me = await browser.xhr(`${ORIGIN}/api/me`)

      expect(me.status).toBe(200)
      expect(me.json<{ sub: string }>()).toMatchObject({ sub: 'user-42' })
    })

    it('serves the assets to the signed-in browser', async () => {
      const asset = await browser.xhr(`${ORIGIN}/assets/app-eZr2sdaR.js`, { headers: SCRIPT })

      expect(asset.status).toBe(200)
    })

    it('keeps an API miss a JSON 404 for a fetch and for a navigation', async () => {
      const fetched = await browser.xhr(`${ORIGIN}/api/typo`)
      expect(fetched.status).toBe(404)
      expect(fetched.headers['content-type']).toMatch(/^application\/json/)

      // One hop: the answer itself, with no redirect in front of it.
      const navigated = await browser.navigate(`${ORIGIN}/api/typo`)
      expect(navigated.hops).toHaveLength(1)
      expect(navigated.status).toBe(404)
      expect(navigated.headers['content-type']).toMatch(/^application\/json/)
    })

    it('does not hand a fetch of a client route the page', async () => {
      const res = await browser.xhr(`${ORIGIN}/dashboard`)

      expect(res.status).toBe(404)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
    })

    it('forbids the API a role the user lacks', async () => {
      const res = await browser.xhr(`${ORIGIN}/api/admin`)

      expect(res.status).toBe(403)
    })

    it('sends the browser back through the provider once the session is gone', async () => {
      const session = await browser.cookieLike(ORIGIN, 'session')
      await browser.dropCookie(ORIGIN, session!.key)

      const asset = await browser.xhr(`${ORIGIN}/assets/app-eZr2sdaR.js`, { headers: SCRIPT })
      expect(asset.status).toBe(401)

      const page = await browser.navigate(`${ORIGIN}/dashboard`)
      expect(page.hops[0].location).toContain(`${provider.origin}/authorize`)
      expect(page.status).toBe(200)
      expect(page.text()).toContain('<div id="root">')
    })
  })

  describe('public shell', () => {
    let running: RunningApp

    beforeAll(async () => {
      running = await bff(provider, false)
    })

    afterAll(async () => {
      await running.close()
    })

    it('serves the page and its assets to a stranger, and only the API asks for a sign-in', async () => {
      const browser = new Browser()

      const page = await browser.navigate(`${ORIGIN}/dashboard`)
      expect(page.hops).toHaveLength(1)
      expect(page.status).toBe(200)
      expect(page.text()).toContain('<div id="root">')

      const asset = await browser.xhr(`${ORIGIN}/assets/app-eZr2sdaR.js`, { headers: SCRIPT })
      expect(asset.status).toBe(200)

      const me = await browser.xhr(`${ORIGIN}/api/me`)
      expect(me.status).toBe(401)
    })
  })
})
