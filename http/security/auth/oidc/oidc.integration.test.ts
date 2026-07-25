import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fastify from 'fastify'
import FastifyCookie from '@fastify/cookie'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import type { JWK, JWTVerifyGetKey, KeyLike } from 'jose'
import {
  AllowAnonymous,
  Authorize,
  type Context,
  Controller,
  Get,
  Claim,
  Params,
  createWebApplication,
  fastifyAdapterFactory,
  context,
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
  fastifyInstance: ReturnType<typeof fastify>,
  jwksResolver?: (uri: string) => JWTVerifyGetKey,
) {
  const builder = createWebApplication(fastifyAdapterFactory(fastifyInstance))
  builder.authentication.addOIDC('Google', opts => {
    opts
      .clientID(CLIENT_ID)
      .clientSecret('oidc-client-secret')
      .sessionSecret(SESSION_SECRET)
      .callbackURL(CALLBACK_URL)
      .authorizationEndpoint(`${ISSUER}/auth`)
      .tokenEndpoint(`${ISSUER}/token`)
      .jwksURI(`${ISSUER}/jwks`)
      .issuer(ISSUER)
    if (jwksResolver) {
      opts.jwksResolver(jwksResolver)
    }
  })
  void builder.authorization
  return builder
}

async function makeStateCookie(nonce: string, state = 'oidc-st') {
  return encodeState(
    { state, nonce, codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/dashboard', scheme: SCHEME, issuer: ISSUER },
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

    const f = fastify()
    f.register(FastifyCookie)
    const app = makeOIDCApp(f).build()
    await app.ready()

    const res = await app.fetch('/oidc-int-challenge')
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
    let privateKey: KeyLike
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
        .setExpirationTime('1h')
        .sign(privateKey)
    }

    function mockTokenEndpoint(nonce: string) {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts?: RequestInit) => {
        if (opts?.method === 'POST') {
          const idToken = await signIDToken(nonce)
          return { ok: true, json: () => Promise.resolve({ id_token: idToken, access_token: 'at' }) }
        }
        return { ok: false, status: 404 }
      }))
    }

    it('valid callback → 302 to returnTo + session cookie set', async () => {
      const nonce = 'valid-nonce'
      mockTokenEndpoint(nonce)

      const stateCookie = await makeStateCookie(nonce)
      const f = fastify()
      f.register(FastifyCookie)
      const app = makeOIDCApp(f, jwksResolver).build()
      await app.ready()

      const res = await app.fetch(
        `${CALLBACK_PATH}?code=code&state=oidc-st`,
        { headers: { cookie: `__Host-oidc_Google_state=${stateCookie}` } },
      )

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/dashboard')
      expect(res.headers.get('set-cookie')).toContain('__Host-oidc_Google_session=')
    })

    it('callback with state mismatch → 400', async () => {
      const stateCookie = await makeStateCookie('n', 'correct-state')
      const f = fastify()
      f.register(FastifyCookie)
      const app = makeOIDCApp(f, jwksResolver).build()
      await app.ready()

      const res = await app.fetch(
        `${CALLBACK_PATH}?code=c&state=wrong-state`,
        { headers: { cookie: `__Host-oidc_Google_state=${stateCookie}` } },
      )

      expect(res.status).toBe(400)
    })

    it('callback with nonce mismatch → 400', async () => {
      mockTokenEndpoint('wrong-nonce')
      const stateCookie = await makeStateCookie('correct-nonce')
      const f = fastify()
      f.register(FastifyCookie)
      const app = makeOIDCApp(f, jwksResolver).build()
      await app.ready()

      const res = await app.fetch(
        `${CALLBACK_PATH}?code=c&state=oidc-st`,
        { headers: { cookie: `__Host-oidc_Google_state=${stateCookie}` } },
      )

      expect(res.status).toBe(400)
    })

    it('callback failures return a generic body that discloses no internals', async () => {
      mockTokenEndpoint('wrong-nonce')
      const stateCookie = await makeStateCookie('correct-nonce')
      const f = fastify({ logger: false })
      f.register(FastifyCookie)
      const app = makeOIDCApp(f, jwksResolver).build()
      await app.ready()

      const res = await app.fetch(
        `${CALLBACK_PATH}?code=c&state=oidc-st`,
        { headers: { cookie: `__Host-oidc_Google_state=${stateCookie}` } },
      )
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
      @Params([context()])
      @Get('/')
      index(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [OIDCIntSessionController]

    const sessionJWT = await makeSessionCookie([new Claim('sub', 'oidc-int-user', ISSUER)])
    const f = fastify()
    f.register(FastifyCookie)
    const app = makeOIDCApp(f).build()
    await app.ready()

    const res = await app.fetch('/oidc-int-session', {
      headers: { cookie: `__Host-oidc_Google_session=${sessionJWT}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
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

    const f = fastify()
    f.register(FastifyCookie)
    const app = makeOIDCApp(f).build()
    await app.ready()

    const [pub, prot] = await Promise.all([
      app.fetch('/oidc-int-anon/public'),
      app.fetch('/oidc-int-anon/protected'),
    ])

    expect(pub.status).toBe(200)
    expect(prot.status).toBe(302)
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

    const sessionJWT = await makeSessionCookie([
      new Claim('sub', 'admin', ISSUER),
      new Claim('roles', 'admin', ISSUER),
    ])
    const f = fastify()
    f.register(FastifyCookie)
    const app = makeOIDCApp(f).build()
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
    const f = fastify()
    f.register(FastifyCookie)
    const app = makeOIDCApp(f).build()
    await app.ready()

    const res = await app.fetch('/oidc-int-role-403', {
      headers: { cookie: `__Host-oidc_Google_session=${sessionJWT}` },
    })
    expect(res.status).toBe(403)
  })

  it('throws at startup if @fastify/cookie is not registered', async () => {
    const builder = makeOIDCApp(fastify())
    await expect(builder.build().ready()).rejects.toThrow('@fastify/cookie')
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

    const f = fastify()
    f.register(FastifyCookie)
    const builder = makeOIDCApp(f)
    await expect(builder.build().ready()).rejects.toThrow('conflicts with a registered controller route')
  })
})
