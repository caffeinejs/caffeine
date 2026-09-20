import { Claim, type OAuth2AuthenticationOptionsBuilder, newRouter } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { startApp } from './internal/app.js'
import { Browser, type Page } from './internal/browser/index.js'
import { OAUTH_SERVER, oauthServerUp, springLogin } from './internal/spring/index.js'
import { required } from './internal/strict.js'
import { startStubProvider } from './internal/stub_provider.js'

// The redirect URI registered for the client in test/services/oauthserver, so the port is not negotiable.
const PORT = 9999
const ORIGIN = `http://localhost:${PORT}`
const SESSION_SECRET = 'spring-oauth2-e2e-session-secret-32!'

const SCHEME = 'spring-oauth2'

function spring(o: OAuth2AuthenticationOptionsBuilder): OAuth2AuthenticationOptionsBuilder {
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
}

function routes() {
  return newRouter().mount(
    newRouter('/me')
      .authorize({})
      .get('/', ctx => Object.fromEntries(ctx.user.claims().map(claim => [claim.type, claim.value]))),
    newRouter('/admin')
      .authorize({ roles: ['admin'] })
      .get('/', () => ({ ok: true })),
    newRouter('/superadmin')
      .authorize({ roles: ['superadmin'] })
      .get('/', () => ({ ok: true })),
  )
}

async function signIn(browser: Browser, url: string, username = 'alice', password = 'wonderland'): Promise<Page> {
  return springLogin(browser, await browser.navigate(url), username, password)
}

/** Starts an application for one case and closes it whatever the case does: every one needs the same port. */
async function withApp(
  configure: (o: OAuth2AuthenticationOptionsBuilder) => unknown,
  run: () => Promise<void>,
): Promise<void> {
  const running = await startApp(
    app => app.authentication(auth => auth.addOAuth2(SCHEME, o => configure(spring(o)))).mount(routes()),
    { port: PORT },
  )

  try {
    await run()
  } finally {
    await running.close()
  }
}

const up = required('oauthserver', await oauthServerUp())

describe.skipIf(!up)('OAuth 2.0 sign-in against Spring Authorization Server', () => {
  it('signs in with the identity the user info endpoint returns', async () => {
    await withApp(
      o => o.mapClaims({ email: 'email', name: 'name' }),
      async () => {
        const browser = new Browser()

        const login = await browser.navigate(`${ORIGIN}/me`)
        expect(login.hops[0]).toMatchObject({ url: `${ORIGIN}/me`, status: 302 })
        expect(login.hops[0].location).toContain(`${OAUTH_SERVER}/oauth2/authorize`)

        const home = await springLogin(browser, login, 'alice', 'wonderland')

        const callback = home.hops.find(hop => hop.url.startsWith(`${ORIGIN}/oauth2/callback`))
        expect(callback).toMatchObject({ status: 302, location: '/me' })
        expect(home.url).toBe(`${ORIGIN}/me`)
        expect(home.json()).toEqual({ sub: 'alice', email: 'alice@example.com', name: 'Alice Liddell' })
      },
    )
  })

  // The user info body is unsigned JSON whose fields the provider chooses, and often the user. Nothing in it
  // becomes a claim unless the application named it, and above all not a role.
  it('maps nothing the application did not name, so the provider cannot hand out roles', async () => {
    await withApp(
      o => o,
      async () => {
        const browser = new Browser()
        const home = await signIn(browser, `${ORIGIN}/me`)

        // The provider's body carries email, name and `roles: [admin, user]`. Only the subject arrived.
        expect(home.json()).toEqual({ sub: 'alice' })
        expect((await browser.navigate(`${ORIGIN}/admin`)).status).toBe(403)
      },
    )
  })

  it('refuses to start when a user info field is renamed into the role claim', async () => {
    const outcome = await startApp(
      app => app.authentication(auth => auth.addOAuth2(SCHEME, o => spring(o).mapClaims({ roles: 'roles' }))),
      { port: PORT },
    ).then(
      // Closed before failing the case, or the port stays taken for every case after this one.
      running => running.close().then(() => 'started'),
      (error: Error) => error.message,
    )

    expect(outcome).toMatch(/role claim "roles"/)
  })

  it('authorizes by roles once a claim mapper takes them on deliberately', async () => {
    await withApp(
      o =>
        o.claimMapper(userInfo => [
          new Claim('sub', String(userInfo.sub), OAUTH_SERVER),
          ...(userInfo.roles as string[]).map(role => new Claim('roles', role, OAUTH_SERVER)),
        ]),
      async () => {
        const alice = new Browser()
        await signIn(alice, `${ORIGIN}/me`)
        expect((await alice.navigate(`${ORIGIN}/admin`)).status).toBe(200)
        expect((await alice.navigate(`${ORIGIN}/superadmin`)).status).toBe(403)

        const bob = new Browser()
        await signIn(bob, `${ORIGIN}/me`, 'bob', 'builder')
        expect((await bob.navigate(`${ORIGIN}/admin`)).status).toBe(403)
      },
    )
  })

  // RFC 6749 §2.3.1 prefers the Authorization header to credentials in the body, and has the client form-urlencode
  // both halves before they are base64-encoded. This client takes the header only, and its secret holds a `+`,
  // which a server decodes as a space when it arrives unencoded.
  describe('with a client that takes its credentials as HTTP Basic only', () => {
    const basicOnly = (o: OAuth2AuthenticationOptionsBuilder) =>
      o.clientID('caffeine-oauth2-basic').clientSecret('caffeine+oauth2/basic:secret%')

    it('signs in once told to send them that way', async () => {
      await withApp(
        o => basicOnly(o).tokenEndpointAuthMethod('client_secret_basic'),
        async () => {
          const home = await signIn(new Browser(), `${ORIGIN}/me`)

          expect(home.url).toBe(`${ORIGIN}/me`)
          expect(home.json()).toEqual({ sub: 'alice' })
        },
      )
    })

    it('fails cleanly while they still travel in the body', async () => {
      await withApp(basicOnly, async () => {
        const browser = new Browser()
        const failed = await signIn(browser, `${ORIGIN}/me`)

        expect(failed.url).toContain(`${ORIGIN}/oauth2/callback`)
        expect(failed.status).toBe(400)
        expect(failed.json()).toEqual({ error: 'Authentication failed', statusCode: 400 })
        expect((await browser.xhr(`${ORIGIN}/me`)).status).toBe(401)
      })
    })
  })

  it('sends PKCE by default, and fails cleanly against a client that demands it when told not to', async () => {
    await withApp(
      o => o,
      async () => {
        const login = await new Browser().navigate(`${ORIGIN}/me`)
        const authorize = new URL(login.hops[0].location!)

        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
        expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      },
    )

    await withApp(
      o => o.usePKCE(false),
      async () => {
        const browser = new Browser()
        const page = await browser.navigate(`${ORIGIN}/me`)

        expect(new URL(page.hops[0].location!).searchParams.has('code_challenge')).toBe(false)

        // The provider refuses the request and says so on the callback. Nobody is signed in, nothing crashes.
        expect(page.url.startsWith(`${ORIGIN}/oauth2/callback`)).toBe(true)
        expect(page.status).toBe(400)
        expect(page.json()).toEqual({ error: 'Authentication failed', statusCode: 400 })
        expect(await browser.cookieLike(ORIGIN, '_session')).toBeUndefined()
      },
    )
  })
})

// GitHub identifies a user by a number. The subject claim used to keep the provider's type, so nothing that asks
// for a `sub` that is a string — a refresh token, remember-me, `hasClaim('sub', '583231')` — recognised the user.
describe('OAuth 2.0 sign-in with a provider whose user identifier is a number', () => {
  it('carries the subject as a string', async () => {
    const provider = await startStubProvider({ id: 583231, login: 'octocat' })

    const running = await startApp(
      app =>
        app
          .authentication(auth =>
            auth.addOAuth2(SCHEME, o =>
              o
                .clientID('stub-client')
                .clientSecret('stub-secret')
                .sessionSecret(SESSION_SECRET)
                .callbackURL(`${ORIGIN}/oauth2/callback`)
                .authorizationEndpoint(`${provider.origin}/authorize`)
                .tokenEndpoint(`${provider.origin}/token`)
                .userInfoEndpoint(`${provider.origin}/userinfo`)
                .subjectClaim('id')
                .mapClaims({ login: 'login' }),
            ),
          )
          .mount(routes()),
      { port: PORT },
    )

    try {
      const home = await new Browser().navigate(`${ORIGIN}/me`)

      expect(home.url).toBe(`${ORIGIN}/me`)
      expect(home.json()).toEqual({ sub: '583231', login: 'octocat' })
    } finally {
      await running.close()
      await provider.close()
    }
  })
})
