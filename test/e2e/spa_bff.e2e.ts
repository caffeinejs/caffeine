import { fileURLToPath } from 'node:url'

import { newRouter } from '@caffeinejs/http'
import { staticFiles } from '@caffeinejs/static'
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

function api() {
  return newRouter('/api')
    .get('/me', ctx => Object.fromEntries(ctx.user.claims().map(claim => [claim.type, claim.value])))
    .mount(
      newRouter('/admin')
        .authorize({ roles: ['admin'] })
        .get('/', () => ({ ok: true })),
    )
}

/**
 * A backend-for-frontend over a real socket: the browser lands on a client route, is sent through the identity
 * provider, comes back with a session cookie, and the page and its API calls follow from there.
 */
async function bff(provider: StubProvider, gatedShell: boolean): Promise<RunningApp> {
  return startApp(
    app =>
      app
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
        .with(staticFiles(s => (gatedShell ? s.spa(dist, { authorize: {} }) : s.spa(dist))))
        .mount(api()),
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
