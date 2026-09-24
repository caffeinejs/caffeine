import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import type { JWK, JWTVerifyGetKey, CryptoKey } from 'jose'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  AllowAnonymous,
  Authorize,
  type Context,
  Controller,
  Get,
  Claim,
  Args,
  createWebApplication,
  newRouter,
  $p,
} from '../../../index.js'
import { encodeSession, claimsToSession } from '../internal/remote/session_store.js'
import { encodeState } from '../internal/remote/state_store.js'

const SESSION_SECRET = 'oidc-integration-test-secret-32ch!!'
const CLIENT_ID = 'oidc-test-client-id'
const ISSUER = 'https://oidc-provider.example.com'
const CALLBACK_URL = 'https://oidc-app.example.com/oidc/callback'
const CALLBACK_PATH = '/oidc/callback'
/** Cookie names and derived keys are namespaced by the strategy this app registers. */
const SCHEME = 'Google'

function makeOIDCApp(
  jwksResolver?: (uri: string) => JWTVerifyGetKey,
  { basePath, callbackURL = CALLBACK_URL }: { basePath?: string; callbackURL?: string } = {},
) {
  const builder = createWebApplication()
  if (basePath !== undefined) {
    builder.basePath(basePath)
  }

  builder.authentication(auth =>
    auth.addOIDC('Google', opts => {
      opts
        .clientID(CLIENT_ID)
        .clientSecret('oidc-client-secret')
        .sessionSecret(SESSION_SECRET)
        .callbackURL(callbackURL)
        .authorizationEndpoint(`${ISSUER}/auth`)
        .tokenEndpoint(`${ISSUER}/token`)
        .jwksURI(`${ISSUER}/jwks`)
        .issuer(ISSUER)
      if (jwksResolver) {
        opts.jwksResolver(jwksResolver)
      }
    }),
  )
  return builder
}

async function makeStateCookie(nonce: string, state = 'oidc-st', returnTo = '/dashboard') {
  return encodeState(
    { state, nonce, codeVerifier: 'cv', pkceMethod: 'S256', returnTo, scheme: SCHEME, issuer: ISSUER },
    SESSION_SECRET,
    SCHEME,
  )
}

async function makeSessionCookie(claims: Claim[]) {
  const session = claimsToSession(claims, 'Google')
  return encodeSession(session, SESSION_SECRET, SCHEME, 3600)
}

describe('OIDC integration', () => {
  it('no session → protected route → 302 to provider auth URL with required params', async () => {
    @Authorize()
    @Controller('/oidc-int-challenge')
    class OIDCIntChallengeController {
      @Get('/')
      index() {
        return { ok: true }
      }
    }
    void [OIDCIntChallengeController]

    const app = makeOIDCApp()
    await app.ready()

    // A navigation, so the challenge redirects. Without the header this is a 401 carrying the same URL —
    // see "answers 401 rather than redirecting a caller that is not a browser navigation" below.
    const res = await app.fetch('/oidc-int-challenge', { headers: { 'sec-fetch-mode': 'navigate' } })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toContain(`${ISSUER}/auth`)
    const parsed = new URL(location)
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(parsed.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('scope')).toContain('openid')
    expect(parsed.searchParams.get('state')).toBeTruthy()
    expect(parsed.searchParams.get('nonce')).toBeTruthy()
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy()
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
  })

  describe('callback flow', () => {
    let privateKey: CryptoKey
    let jwkPublic: JWK
    let jwksResolver: (uri: string) => JWTVerifyGetKey

    beforeEach(async () => {
      const pair = await generateKeyPair('RS256')
      privateKey = pair.privateKey
      const jwk = await exportJWK(pair.publicKey)
      jwkPublic = { ...jwk, kid: 'k1', use: 'sig' }
      const localJwks = createLocalJWKSet({ keys: [jwkPublic] })
      jwksResolver = () => localJwks as JWTVerifyGetKey
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function signIDToken(nonce: string) {
      return new SignJWT({ sub: 'oidc-sub', email: 'test@oidc.com', nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey)
    }

    function mockTokenEndpoint(nonce: string) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, opts?: RequestInit) => {
          if (opts?.method === 'POST') {
            const idToken = await signIDToken(nonce)
            return {
              ok: true,
              json: () => Promise.resolve({ id_token: idToken, access_token: 'at', token_type: 'Bearer' }),
            }
          }
          return { ok: false, status: 404 }
        }),
      )
    }

    it('valid callback → 302 to returnTo + session cookie set', async () => {
      const nonce = 'valid-nonce'
      mockTokenEndpoint(nonce)

      const stateCookie = await makeStateCookie(nonce)
      const app = makeOIDCApp(jwksResolver)
      await app.ready()

      const res = await app.fetch(`${CALLBACK_PATH}?code=code&state=oidc-st`, {
        headers: { cookie: `__Host-oidc_Google_state.oidc-st=${stateCookie}` },
      })

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/dashboard')
      expect(res.headers.get('set-cookie')).toContain('__Host-oidc_Google_session=')
    })

    /**
     * Behind a gateway forwarding `/api/...`: `callbackURL` is the URL the provider sends the browser back to, so it
     * carries the base, while the server takes the base off before routing. The callback route has to be where the
     * stripped request lands, and every page the browser is sent on to has to carry the base again.
     */
    describe('under a base path', () => {
      const BASED_CALLBACK_URL = 'https://oidc-app.example.com/api/oidc/callback'
      const stateCookieHeader = (cookie: string) => ({ cookie: `__Host-oidc_Google_state.oidc-st=${cookie}` })

      function basedApp(callbackURL = BASED_CALLBACK_URL) {
        return makeOIDCApp(jwksResolver, { basePath: '/api', callbackURL })
      }

      it('answers the callback the gateway forwards, and comes back to the page under the base', async () => {
        const nonce = 'based-nonce'
        mockTokenEndpoint(nonce)
        const app = basedApp()
        await app.ready()

        const res = await app.fetch(`/api${CALLBACK_PATH}?code=code&state=oidc-st`, {
          headers: stateCookieHeader(await makeStateCookie(nonce, 'oidc-st', '/api/dashboard')),
        })

        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('/api/dashboard')

        // Unlike the cookie scheme's, a remote strategy's cookies stay at `/` under a base: a `__Host-` cookie is
        // refused anywhere else. Applications sharing an origin tell them apart by name.
        const session = res.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-oidc_Google_session='))
        expect(session).toMatch(/;\s*Path=\/(;|$)/i)
      })

      it('answers the callback without the base as well, as any route is', async () => {
        const nonce = 'direct-nonce'
        mockTokenEndpoint(nonce)
        const app = basedApp()
        await app.ready()

        const res = await app.fetch(`${CALLBACK_PATH}?code=code&state=oidc-st`, {
          headers: stateCookieHeader(await makeStateCookie(nonce, 'oidc-st', '/api/dashboard')),
        })

        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('/api/dashboard')
      })

      it('lands on the default path under the base when the state names nowhere safe', async () => {
        const nonce = 'unsafe-nonce'
        mockTokenEndpoint(nonce)
        const app = basedApp()
        await app.ready()

        const res = await app.fetch(`/api${CALLBACK_PATH}?code=code&state=oidc-st`, {
          headers: stateCookieHeader(await makeStateCookie(nonce, 'oidc-st', '//evil.example/phish')),
        })

        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('/api/')
      })

      it('challenges with the base callback URL, and a sign-in URL coming back under the base', async () => {
        const app = basedApp().mount(
          newRouter('/based-private')
            .authorize({})
            .get('/', () => ({ ok: true })),
        )
        await app.ready()

        const navigation = await app.fetch('/api/based-private', { headers: { 'sec-fetch-mode': 'navigate' } })
        expect(navigation.status).toBe(302)
        expect(new URL(navigation.headers.get('location')!).searchParams.get('redirect_uri')).toBe(BASED_CALLBACK_URL)
        // The state cookie has to reach the callback wherever `callbackURL` puts it, so it stays at `/`.
        const state = navigation.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-oidc_Google_state.'))
        expect(state).toMatch(/;\s*Path=\/(;|$)/i)

        const script = await app.fetch('/api/based-private', { headers: { accept: 'application/json' } })
        expect(script.status).toBe(401)
        expect(script.headers.get('location')).toBe(
          `${BASED_CALLBACK_URL}/login?returnTo=${encodeURIComponent('/api/based-private')}`,
        )
      })

      it('starts a sign-in at the login route under the base', async () => {
        const app = basedApp()
        await app.ready()

        const res = await app.fetch('/api/oidc/callback/login?returnTo=/api/x')

        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toContain(`${ISSUER}/auth`)
      })

      it('takes nothing off a callback path outside the base, the base ending on a segment boundary', async () => {
        const app = basedApp('https://oidc-app.example.com/apix/cb')
        await app.ready()

        // No state cookie: the route answers with its own refusal, which is what shows it is there.
        expect((await app.fetch('/apix/cb?code=code&state=oidc-st')).status).toBe(400)
        expect((await app.fetch('/cb?code=code&state=oidc-st')).status).toBe(404)
      })

      it('refuses a route of the application at the callback path, both being relative to it', async () => {
        const app = basedApp().mount(newRouter('/oidc').get('/callback', () => ({ ok: true })))

        await expect(app.ready()).rejects.toThrow(/"\/oidc\/callback" conflicts with a registered controller route/)
      })
    })

    it('callback with state mismatch → 400', async () => {
      const stateCookie = await makeStateCookie('n', 'correct-state')
      const app = makeOIDCApp(jwksResolver)
      await app.ready()

      // Planted under the name the *query* state derives, so the lookup succeeds and the sealed-vs-parameter
      // comparison is what rejects it rather than the cookie simply being absent.
      const res = await app.fetch(`${CALLBACK_PATH}?code=c&state=wrong-state`, {
        headers: { cookie: `__Host-oidc_Google_state.wrong-state=${stateCookie}` },
      })

      expect(res.status).toBe(400)
    })

    it('callback with nonce mismatch → 400', async () => {
      mockTokenEndpoint('wrong-nonce')
      const stateCookie = await makeStateCookie('correct-nonce')
      const app = makeOIDCApp(jwksResolver)
      await app.ready()

      const res = await app.fetch(`${CALLBACK_PATH}?code=c&state=oidc-st`, {
        headers: { cookie: `__Host-oidc_Google_state.oidc-st=${stateCookie}` },
      })

      expect(res.status).toBe(400)
    })

    it('callback failures return a generic body that discloses no internals', async () => {
      mockTokenEndpoint('wrong-nonce')
      const stateCookie = await makeStateCookie('correct-nonce')
      const app = makeOIDCApp(jwksResolver)
      await app.ready()

      const res = await app.fetch(`${CALLBACK_PATH}?code=c&state=oidc-st`, {
        headers: { cookie: `__Host-oidc_Google_state.oidc-st=${stateCookie}` },
      })
      const body = await res.text()

      expect(res.status).toBe(400)
      expect(JSON.parse(body)).toEqual({ error: 'Authentication failed', statusCode: 400 })

      // No diagnostic detail may reach the client.
      expect(body).not.toContain('nonce')
      expect(body).not.toContain('id_token')
      expect(body).not.toContain(ISSUER)
      expect(body).not.toContain(CLIENT_ID)
    })
  })

  it('session cookie → 200 with correct claims on protected route', async () => {
    @Authorize()
    @Controller('/oidc-int-session')
    class OIDCIntSessionController {
      @Args([$p.context()])
      @Get('/')
      index(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [OIDCIntSessionController]

    const sessionJWT = await makeSessionCookie([new Claim('sub', 'oidc-int-user', ISSUER)])
    const app = makeOIDCApp()
    await app.ready()

    const res = await app.fetch('/oidc-int-session', {
      headers: { cookie: `__Host-oidc_Google_session=${sessionJWT}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.sub).toBe('oidc-int-user')
  })

  it('@AllowAnonymous overrides class-level @Authorize → 200 with no session', async () => {
    @Authorize()
    @Controller('/oidc-int-anon')
    class OIDCIntAnonController {
      @AllowAnonymous()
      @Get('/public')
      public() {
        return { ok: true }
      }

      @Get('/protected')
      protected() {
        return { ok: true }
      }
    }
    void [OIDCIntAnonController]

    const app = makeOIDCApp()
    await app.ready()

    const [pub, prot] = await Promise.all([app.fetch('/oidc-int-anon/public'), app.fetch('/oidc-int-anon/protected')])

    expect(pub.status).toBe(200)
    // 401 rather than 302: neither request claims to be a browser navigation, and the point here is that the
    // protected route was challenged at all, not which shape the challenge took.
    expect(prot.status).toBe(401)
  })

  /**
   * The redirect into the provider is a browser mechanism: `fetch` follows it itself, lands on a cross-origin
   * provider that sends no CORS headers, and the caller sees a network error instead of "you are not signed
   * in". So a caller that does not look like a navigation gets a 401 it can actually read, with the same
   * authorization URL — and the same state cookie — it would have been redirected to.
   */
  it('answers 401 rather than redirecting a caller that is not a browser navigation', async () => {
    @Authorize()
    @Controller('/oidc-int-xhr')
    class OIDCIntXHRController {
      @Get('/')
      index() {
        return { ok: true }
      }
    }
    void [OIDCIntXHRController]

    const app = makeOIDCApp()
    await app.ready()

    const res = await app.fetch('/oidc-int-xhr', { headers: { accept: 'application/json' } })

    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBe(
      `https://oidc-app.example.com${CALLBACK_PATH}/login?returnTo=${encodeURIComponent('/oidc-int-xhr')}`,
    )
    // Nothing is started for a caller that cannot follow it there.
    expect(res.headers.get('set-cookie')).toBeNull()

    // Sending the browser to that URL is what starts the sign-in: a state cookie named per flow —
    // `<base>.<state>` — and the way to the provider. No policy stands in front of the route.
    const start = await app.fetch(`${CALLBACK_PATH}/login?returnTo=${encodeURIComponent('/oidc-int-xhr')}`)

    expect(start.status).toBe(302)
    expect(start.headers.get('location')).toContain(`${ISSUER}/auth`)
    expect(start.headers.get('set-cookie')).toMatch(/oidc_Google_state\.[A-Za-z0-9_-]+=/)
    expect(start.headers.get('cache-control')).toContain('no-store')
  })

  it('@Authorize({ roles }) + matching role → 200', async () => {
    @Authorize({ roles: ['admin'] })
    @Controller('/oidc-int-role-ok')
    class OIDCIntRoleOkController {
      @Get('/')
      index() {
        return { ok: true }
      }
    }
    void [OIDCIntRoleOkController]

    const sessionJWT = await makeSessionCookie([new Claim('sub', 'admin', ISSUER), new Claim('roles', 'admin', ISSUER)])
    const app = makeOIDCApp()
    await app.ready()

    const res = await app.fetch('/oidc-int-role-ok', {
      headers: { cookie: `__Host-oidc_Google_session=${sessionJWT}` },
    })
    expect(res.status).toBe(200)
  })

  it('@Authorize({ roles }) + wrong role → 403', async () => {
    @Authorize({ roles: ['admin'] })
    @Controller('/oidc-int-role-403')
    class OIDCIntRole403Controller {
      @Get('/')
      index() {
        return { ok: true }
      }
    }
    void [OIDCIntRole403Controller]

    const sessionJWT = await makeSessionCookie([
      new Claim('sub', 'viewer', ISSUER),
      new Claim('roles', 'viewer', ISSUER),
    ])
    const app = makeOIDCApp()
    await app.ready()

    const res = await app.fetch('/oidc-int-role-403', {
      headers: { cookie: `__Host-oidc_Google_session=${sessionJWT}` },
    })
    expect(res.status).toBe(403)
  })

  // The adapter registers @fastify/cookie itself, so the state and session cookies this flow depends on are
  // parsed with nothing asked of the application.
  it('starts with @fastify/cookie registered by nobody', async () => {
    const builder = makeOIDCApp()
    await expect(builder.ready()).resolves.toBeUndefined()
    await builder.close()
  })

  it('throws at startup if controller route conflicts with callbackPath', async () => {
    @Controller('/oidc')
    class ConflictingController {
      @Get('/callback')
      get() {
        return {}
      }
    }
    void [ConflictingController]

    const builder = makeOIDCApp()
    await expect(builder.ready()).rejects.toThrow('conflicts with a registered controller route')
  })
})
