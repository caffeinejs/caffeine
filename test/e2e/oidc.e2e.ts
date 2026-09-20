import { randomUUID } from 'node:crypto'

import {
  AuthenticationSchemeProvider,
  AuthenticationService,
  type OIDCAuthenticationHandler,
  type OIDCAuthenticationOptionsBuilder,
  newRouter,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type Page } from './internal/browser/index.js'
import type { OAuth2OptionsBuilder } from './internal/builders.js'
import { reachable } from './internal/redis/index.js'
import { REDIS_URL, RedisTicketStore, connectRedis, type RedisClient } from './internal/redis/stores.js'
import { OAUTH_SERVER, oauthServerUp, springLogin } from './internal/spring/index.js'
import { required } from './internal/strict.js'

// The redirect URIs registered for the clients in test/services/oauthserver, so the port is not negotiable —
// and neither is running these applications one at a time.
const PORT = 9999
const ORIGIN = `http://localhost:${PORT}`
const SESSION_SECRET = 'spring-oidc-e2e-session-secret-32c!!'

const OIDC = 'spring'
const OAUTH2 = 'spring-oauth2'

function springOIDC(o: OIDCAuthenticationOptionsBuilder): OIDCAuthenticationOptionsBuilder {
  return o
    .clientID('caffeine-oidc')
    .clientSecret('caffeine-oidc-secret')
    .sessionSecret(SESSION_SECRET)
    .callbackURL(`${ORIGIN}/oidc/callback`)
    .authorizationEndpoint(`${OAUTH_SERVER}/oauth2/authorize`)
    .tokenEndpoint(`${OAUTH_SERVER}/oauth2/token`)
    .jwksURI(`${OAUTH_SERVER}/oauth2/jwks`)
    .issuer(OAUTH_SERVER)
    .scopes('openid', 'profile', 'email')
}

function springOAuth2(o: OAuth2OptionsBuilder): OAuth2OptionsBuilder {
  return o
    .clientID('caffeine-oauth2')
    .clientSecret('caffeine-oauth2-secret')
    .sessionSecret(SESSION_SECRET)
    .callbackURL(`${ORIGIN}/oauth2/callback`)
    .authorizationEndpoint(`${OAUTH_SERVER}/oauth2/authorize`)
    .tokenEndpoint(`${OAUTH_SERVER}/oauth2/token`)
    .userInfoEndpoint(`${OAUTH_SERVER}/userinfo`)
    .subjectClaim('sub')
    .scopes('openid', 'profile', 'email')
    .mapClaims({ email: 'email' })
}

// Routers rather than controllers: a controller registers globally, so every application built in this file
// would carry the routes of all the others.
function routes(scheme: string) {
  const identity = newRouter('/me')
    .authorize({})
    .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value, email: ctx.user.findFirst('email')?.value }))

  const reports = newRouter('/reports')
    .authorize({})
    .get('/:year', ctx => ({ year: ctx.req.param('year'), tab: ctx.req.query('tab') }))

  const session = newRouter()
    .inject({ auth: AuthenticationService, schemes: AuthenticationSchemeProvider })
    .get('/public', () => ({ ok: true }))
    .get('/signed-out', () => ({ signedOut: true }))
    // A sign-in link: the application decides where the user lands afterwards, and says so to the challenge.
    .get('/login', async (ctx, { auth }) => {
      await auth.challenge(ctx, scheme, { redirectURI: ctx.req.query('returnTo') })
    })
    .post('/logout', async (ctx, { auth }) => {
      await auth.revoke(ctx, scheme)
      return { ok: true }
    })
    .get('/logout/provider', async (ctx, { schemes }) => {
      await (schemes.schemeFor(scheme)!.get() as OIDCAuthenticationHandler).signOutRedirect(ctx)
    })

  return newRouter().mount(
    identity,
    reports,
    session,
    newRouter('/admin')
      .authorize({ roles: ['admin'] })
      .get('/', () => ({ ok: true })),
    newRouter('/superadmin')
      .authorize({ roles: ['superadmin'] })
      .get('/', () => ({ ok: true })),
  )
}

/** Opens a protected URL and signs in at the provider. Returns the page the browser ended on. */
async function signIn(browser: Browser, url: string, username = 'alice', password = 'wonderland'): Promise<Page> {
  return springLogin(browser, await browser.navigate(url), username, password)
}

async function sessionCookie(browser: Browser) {
  const cookie = await browser.cookieLike(ORIGIN, '_session')
  if (cookie === undefined) {
    throw new Error('The browser holds no session cookie')
  }

  return cookie
}

const up = required('oauthserver', await oauthServerUp())
const redisUp = required('redis', await reachable(REDIS_URL))

describe.skipIf(!up)('OIDC sign-in against Spring Authorization Server', () => {
  describe('with the session sealed in the cookie', () => {
    let running: RunningApp

    beforeAll(async () => {
      running = await startApp(app => app.authentication(auth => auth.addOIDC(OIDC, springOIDC)).mount(routes(OIDC)), {
        port: PORT,
      })
    })

    afterAll(() => running.close())

    it('takes a browser from a protected URL, through the provider, back to that URL signed in', async () => {
      const browser = new Browser()

      const login = await browser.navigate(`${ORIGIN}/me`)

      // The application challenged with a redirect, and the provider asked the user to sign in.
      expect(login.hops[0]).toMatchObject({ url: `${ORIGIN}/me`, status: 302 })
      expect(login.hops[0].location).toContain(`${OAUTH_SERVER}/oauth2/authorize`)

      const home = await springLogin(browser, login, 'alice', 'wonderland')

      // Provider -> callback -> the URL the challenge interrupted.
      const callback = home.hops.find(hop => hop.url.startsWith(`${ORIGIN}/oidc/callback`))
      expect(callback).toMatchObject({ status: 302, location: '/me' })

      expect(home.url).toBe(`${ORIGIN}/me`)
      expect(home.status).toBe(200)
      expect(home.json()).toEqual({ sub: 'alice', email: 'alice@example.com' })
    })

    // Every one of these sets a session or state cookie, or carries the URL the state rides in. A shared cache
    // that kept one would hand a session, or a sign-in round trip, to the next caller of the URL.
    it('tells every cache to keep its hands off the challenge, the callback and the sign-out', async () => {
      const browser = new Browser()

      const login = await browser.navigate(`${ORIGIN}/me`)
      expect(login.hops[0].headers['cache-control']).toBe('no-store')
      expect((await new Browser().xhr(`${ORIGIN}/me`)).headers['cache-control']).toBe('no-store')

      const home = await springLogin(browser, login, 'alice', 'wonderland')
      const callback = home.hops.find(hop => hop.url.startsWith(`${ORIGIN}/oidc/callback`))!
      expect(callback.headers['cache-control']).toBe('no-store')

      expect((await browser.postJSON(`${ORIGIN}/logout`, {})).headers['cache-control']).toBe('no-store')
    })

    it('sends PKCE, state and nonce on the authorization request', async () => {
      const login = await new Browser().navigate(`${ORIGIN}/me`)
      const authorize = new URL(login.hops[0].location!)

      expect(authorize.searchParams.get('response_type')).toBe('code')
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(authorize.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oidc/callback`)
    })

    it('returns to a deep link with its query intact', async () => {
      const home = await signIn(new Browser(), `${ORIGIN}/reports/2026?tab=summary`)

      expect(home.url).toBe(`${ORIGIN}/reports/2026?tab=summary`)
      expect(home.json()).toEqual({ year: '2026', tab: 'summary' })
    })

    it('answers a script 401 with the login URL instead of a redirect it could not follow', async () => {
      const browser = new Browser()

      const challenge = await browser.xhr(`${ORIGIN}/me`)

      expect(challenge.status).toBe(401)
      const body = challenge.json<{ error: string; loginURL: string }>()
      expect(body.error).toBe('authentication_required')
      expect(body.loginURL).toContain(`${OAUTH_SERVER}/oauth2/authorize`)
      expect(challenge.headers.location).toBe(body.loginURL)

      // The state cookie rode on the 401, so sending the browser to that URL completes the same flow.
      const home = await springLogin(browser, await browser.navigate(body.loginURL), 'alice', 'wonderland')

      expect(home.url).toBe(`${ORIGIN}/me`)
      expect(home.status).toBe(200)
    })

    it('authorizes by the roles the id_token carries', async () => {
      const alice = new Browser()
      await signIn(alice, `${ORIGIN}/me`)

      expect((await alice.navigate(`${ORIGIN}/admin`)).status).toBe(200)
      expect((await alice.navigate(`${ORIGIN}/superadmin`)).status).toBe(403)

      const bob = new Browser()
      const home = await signIn(bob, `${ORIGIN}/me`, 'bob', 'builder')
      expect(home.json()).toEqual({ sub: 'bob', email: 'bob@example.com' })

      // Signed in, and still not an admin: forbidden, not challenged again.
      const admin = await bob.navigate(`${ORIGIN}/admin`)
      expect(admin.status).toBe(403)
      expect(admin.hops).toHaveLength(1)
    })

    it('leaves an anonymous route alone', async () => {
      const page = await new Browser().navigate(`${ORIGIN}/public`)

      expect(page.status).toBe(200)
      expect(page.hops).toHaveLength(1)
    })

    describe('a callback that does not belong to a flow this browser started', () => {
      async function startedFlow() {
        const browser = new Browser()
        const login = await browser.navigate(`${ORIGIN}/me`)
        const state = new URL(login.hops[0].location!).searchParams.get('state')!

        return { browser, login, state }
      }

      function expectGenericFailure(page: Page) {
        expect(page.status).toBe(400)
        expect(page.json()).toEqual({ error: 'Authentication failed', statusCode: 400 })
      }

      it('is refused when the state names no flow', async () => {
        const { browser } = await startedFlow()

        expectGenericFailure(
          await browser.navigate(`${ORIGIN}/oidc/callback?code=anything&state=AAAAAAAAAAAAAAAAAAAAAA`),
        )
      })

      it('is refused when the state is another browser’s', async () => {
        const { state } = await startedFlow()

        // A login CSRF: the attacker's own callback URL, opened in the victim's browser.
        expectGenericFailure(await new Browser().navigate(`${ORIGIN}/oidc/callback?code=anything&state=${state}`))
      })

      it('is refused when it is replayed', async () => {
        const browser = new Browser()
        const home = await signIn(browser, `${ORIGIN}/me`)
        const callback = home.hops.find(hop => hop.url.startsWith(`${ORIGIN}/oidc/callback`))!

        expectGenericFailure(await browser.navigate(callback.url))
      })

      it('is refused when the provider reports an error, without echoing what it said', async () => {
        const { browser, state } = await startedFlow()

        const page = await browser.navigate(
          `${ORIGIN}/oidc/callback?error=access_denied&error_description=internal-detail-42&state=${state}`,
        )

        expectGenericFailure(page)
        expect(page.text()).not.toContain('internal-detail-42')
      })

      it('is refused when the state is malformed', async () => {
        const { browser } = await startedFlow()

        expectGenericFailure(await browser.navigate(`${ORIGIN}/oidc/callback?code=anything&state=../../etc`))
      })
    })

    it('challenges again on a tampered session cookie, and never fails with a 500', async () => {
      const browser = new Browser()
      await signIn(browser, `${ORIGIN}/me`)

      const { key } = await sessionCookie(browser)
      await browser.tamperCookie(ORIGIN, key, value => `${value.slice(0, -4)}AAAA`)

      const page = await browser.navigate(`${ORIGIN}/me`)

      expect(page.hops[0]).toMatchObject({ url: `${ORIGIN}/me`, status: 302 })
      expect(page.hops[0].location).toContain(`${OAUTH_SERVER}/oauth2/authorize`)
      expect(page.hops.every(hop => hop.status < 500)).toBe(true)
    })

    it.each([
      ['an absolute URL on another origin', 'https://evil.example/steal'],
      ['a protocol-relative URL', '//evil.example/steal'],
      ['a backslash the browser reads as a slash', '/\\evil.example/steal'],
    ])('lands on the default path when asked to return to %s', async (_label, returnTo) => {
      const browser = new Browser()

      const login = await browser.navigate(`${ORIGIN}/login?returnTo=${encodeURIComponent(returnTo)}`)
      const home = await springLogin(browser, login, 'alice', 'wonderland')

      const callback = home.hops.find(hop => hop.url.startsWith(`${ORIGIN}/oidc/callback`))
      expect(callback).toMatchObject({ status: 302, location: '/' })
      expect(home.hops.some(hop => hop.url.includes('evil.example'))).toBe(false)
    })

    it('returns to a same-origin path the application asked for', async () => {
      const browser = new Browser()

      const login = await browser.navigate(`${ORIGIN}/login?returnTo=${encodeURIComponent('/reports/2025?tab=q4')}`)
      const home = await springLogin(browser, login, 'alice', 'wonderland')

      expect(home.url).toBe(`${ORIGIN}/reports/2025?tab=q4`)
      expect(home.status).toBe(200)
    })

    it('signs out by clearing the cookie — and only that, because the cookie is the session', async () => {
      const browser = new Browser()
      await signIn(browser, `${ORIGIN}/me`)

      // A second holder of the same cookie: a synced profile, a captured header.
      const copy = new Browser()
      await copy.adoptCookie(ORIGIN, await sessionCookie(browser))
      expect((await copy.xhr(`${ORIGIN}/me`)).status).toBe(200)

      expect((await browser.postJSON(`${ORIGIN}/logout`, {})).status).toBe(200)

      expect(await browser.cookieLike(ORIGIN, '_session')).toBeUndefined()
      expect((await browser.xhr(`${ORIGIN}/me`)).status).toBe(401)

      // The documented limit of a sealed cookie: nothing server-side exists to revoke, so the copy lives on
      // until it expires. A ticket store is what changes that.
      expect((await copy.xhr(`${ORIGIN}/me`)).status).toBe(200)
    })
  })

  describe('configured from the discovery document', () => {
    it('signs in with the issuer pinned to the one the document declares', async () => {
      const running = await startApp(
        app =>
          app
            .authentication(auth =>
              auth.addOIDC(OIDC, o =>
                o
                  .clientID('caffeine-oidc')
                  .clientSecret('caffeine-oidc-secret')
                  .sessionSecret(SESSION_SECRET)
                  .callbackURL(`${ORIGIN}/oidc/callback`)
                  .discoveryURL(OAUTH_SERVER)
                  .issuer(OAUTH_SERVER)
                  .scopes('openid', 'email'),
              ),
            )
            .mount(routes(OIDC)),
        { port: PORT },
      )

      try {
        const home = await signIn(new Browser(), `${ORIGIN}/me`)

        expect(home.url).toBe(`${ORIGIN}/me`)
        expect(home.json()).toEqual({ sub: 'alice', email: 'alice@example.com' })
      } finally {
        await running.close()
      }
    })

    it('fails closed when the document declares an issuer other than the pinned one', async () => {
      const running = await startApp(
        app =>
          app
            .authentication(auth =>
              auth.addOIDC(OIDC, o =>
                o
                  .clientID('caffeine-oidc')
                  .clientSecret('caffeine-oidc-secret')
                  .sessionSecret(SESSION_SECRET)
                  .callbackURL(`${ORIGIN}/oidc/callback`)
                  .discoveryURL(OAUTH_SERVER)
                  .issuer('http://localhost:9000/not-the-issuer'),
              ),
            )
            .mount(routes(OIDC)),
        { port: PORT },
      )

      try {
        const page = await new Browser().navigate(`${ORIGIN}/me`)

        // Nobody is sent to a provider whose identity could not be established.
        expect(page.hops).toHaveLength(1)
        expect(page.status).toBeGreaterThanOrEqual(500)
      } finally {
        await running.close()
      }
    })
  })

  it.todo('answers a failed challenge with the public message only, never the configured issuer')

  // Everything is gated, the callback included unless it is exempt — and it is where the provider sends a user
  // who is, by definition, not signed in yet.
  describe('in an application that requires a signed-in user everywhere', () => {
    let running: RunningApp

    beforeAll(async () => {
      running = await startApp(
        app =>
          app
            .authentication(auth => auth.addOIDC(OIDC, springOIDC))
            .authorization(authz => authz.requireAuthenticatedByDefault())
            .mount(newRouter('/dashboard').get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value }))),
        { port: PORT },
      )
    })

    afterAll(() => running.close())

    it('still lets the provider hand the user back, and lands them on the route that declared nothing', async () => {
      const browser = new Browser()

      const login = await browser.navigate(`${ORIGIN}/dashboard`)
      expect(login.hops[0]).toMatchObject({ url: `${ORIGIN}/dashboard`, status: 302 })

      const home = await springLogin(browser, login, 'alice', 'wonderland')

      expect(home.url).toBe(`${ORIGIN}/dashboard`)
      expect(home.json()).toEqual({ sub: 'alice' })
    })
  })

  describe.skipIf(!redisUp)('with sessions held in a Redis ticket store', () => {
    let running: RunningApp
    let redis: RedisClient
    let store: RedisTicketStore

    beforeAll(async () => {
      redis = await connectRedis()
      store = new RedisTicketStore(redis, `caffeine:auth:e2e:${randomUUID()}`)

      running = await startApp(
        app =>
          app
            .authentication(auth =>
              auth.addOIDC(OIDC, o =>
                springOIDC(o)
                  .ticketStore(store)
                  .saveTokens()
                  // Endpoints are configured by hand here, so nothing advertises where to end the session.
                  .endSessionEndpoint(`${OAUTH_SERVER}/connect/logout`)
                  .postLogoutRedirectURI(`${ORIGIN}/signed-out`),
              ),
            )
            .mount(routes(OIDC)),
        { port: PORT },
      )
    })

    afterAll(async () => {
      await running.close()
      await redis.close()
    })

    it('keeps nothing about the user in the cookie', async () => {
      const browser = new Browser()
      await signIn(browser, `${ORIGIN}/me`)

      // A reference to the ticket is a fraction of a sealed session carrying the claims.
      expect((await sessionCookie(browser)).value.length).toBeLessThan(400)
      expect((await browser.xhr(`${ORIGIN}/me`)).json()).toEqual({ sub: 'alice', email: 'alice@example.com' })
    })

    it('ends every copy of the session at sign-out', async () => {
      const browser = new Browser()
      await signIn(browser, `${ORIGIN}/me`)

      const copy = new Browser()
      await copy.adoptCookie(ORIGIN, await sessionCookie(browser))
      expect((await copy.xhr(`${ORIGIN}/me`)).status).toBe(200)

      expect((await browser.postJSON(`${ORIGIN}/logout`, {})).status).toBe(200)

      expect((await browser.xhr(`${ORIGIN}/me`)).status).toBe(401)
      expect((await copy.xhr(`${ORIGIN}/me`)).status).toBe(401)
    })

    it('signs a user out of every browser at once', async () => {
      const laptop = new Browser()
      const phone = new Browser()
      await signIn(laptop, `${ORIGIN}/me`, 'bob', 'builder')
      await signIn(phone, `${ORIGIN}/me`, 'bob', 'builder')

      const other = new Browser()
      await signIn(other, `${ORIGIN}/me`)

      await store.removeBySubject('bob')

      expect((await laptop.xhr(`${ORIGIN}/me`)).status).toBe(401)
      expect((await phone.xhr(`${ORIGIN}/me`)).status).toBe(401)
      expect((await other.xhr(`${ORIGIN}/me`)).status).toBe(200)
    })

    it('ends the session at the provider too, and comes back to the registered post-logout URL', async () => {
      const browser = new Browser()
      await signIn(browser, `${ORIGIN}/me`)

      const page = await browser.navigate(`${ORIGIN}/logout/provider`)

      const logout = page.hops.find(hop => hop.url.startsWith(`${OAUTH_SERVER}/connect/logout`))
      expect(logout).toBeDefined()
      expect(new URL(logout!.url).searchParams.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
      expect(page.url).toBe(`${ORIGIN}/signed-out`)
      expect(page.json()).toEqual({ signedOut: true })

      // Signed out here, and the provider no longer vouches for the user either: the next visit stops at its
      // login form instead of sailing through on the provider's own session.
      const next = await browser.navigate(`${ORIGIN}/me`)
      expect(next.url.startsWith(`${OAUTH_SERVER}/login`)).toBe(true)
    })
  })

  describe('with two strategies against the one provider', () => {
    let running: RunningApp

    beforeAll(async () => {
      running = await startApp(
        app =>
          app
            .authentication(auth => auth.addOIDC(OIDC, springOIDC).addOAuth2(OAUTH2, springOAuth2).default(OIDC))
            .mount(
              newRouter('/via-oidc')
                .authorize({ schemes: [OIDC] })
                .get('/', ctx => ({ via: ctx.user.identities[0]?.authenticationType })),
            )
            .mount(
              newRouter('/via-oauth2')
                .authorize({ schemes: [OAUTH2] })
                .get('/', ctx => ({ via: ctx.user.identities[0]?.authenticationType })),
            ),
        { port: PORT },
      )
    })

    afterAll(() => running.close())

    it('signs in through whichever strategy the route names, each with its own cookies', async () => {
      const browser = new Browser()

      const viaOIDC = await signIn(browser, `${ORIGIN}/via-oidc`)
      expect(viaOIDC.json()).toEqual({ via: OIDC })

      // Already signed in at the provider, so the second strategy completes without a login form.
      const viaOAuth2 = await browser.navigate(`${ORIGIN}/via-oauth2`)
      expect(viaOAuth2.url).toBe(`${ORIGIN}/via-oauth2`)
      expect(viaOAuth2.json()).toEqual({ via: OAUTH2 })

      const names = (await browser.cookies(ORIGIN)).map(cookie => cookie.key)
      expect(names).toContain(`__oidc_${OIDC}_session`)
      expect(names).toContain(`__oauth2_${OAUTH2}_session`)
    })

    it('does not accept one strategy’s session on a route naming the other', async () => {
      const browser = new Browser()
      await signIn(browser, `${ORIGIN}/via-oidc`)

      expect((await browser.xhr(`${ORIGIN}/via-oauth2`)).status).toBe(401)
    })

    it('refuses a state minted by one strategy at the other’s callback', async () => {
      const browser = new Browser()
      const login = await browser.navigate(`${ORIGIN}/via-oidc`)
      const state = new URL(login.hops[0].location!).searchParams.get('state')!

      const page = await browser.navigate(`${ORIGIN}/oauth2/callback?code=anything&state=${state}`)

      expect(page.status).toBe(400)
      expect(page.json()).toEqual({ error: 'Authentication failed', statusCode: 400 })
    })

    it('completes two flows started side by side in one browser', async () => {
      const browser = new Browser()

      // Two tabs, both challenged before either signs in: two state cookies live in the jar at once.
      const first = await browser.navigate(`${ORIGIN}/via-oidc`)
      const second = await browser.navigate(`${ORIGIN}/via-oauth2`)

      const home = await springLogin(browser, second, 'alice', 'wonderland')
      expect(home.url).toBe(`${ORIGIN}/via-oauth2`)

      // The first tab's authorization request is still good, and the provider now knows the user.
      const resumed = await browser.navigate(first.hops[0].location!)
      expect(resumed.url).toBe(`${ORIGIN}/via-oidc`)
      expect(resumed.json()).toEqual({ via: OIDC })
    })
  })
})
