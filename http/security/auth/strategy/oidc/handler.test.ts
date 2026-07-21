import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import type { JWTVerifyGetKey, KeyLike } from 'jose'
import type { Context } from '../../../../context.js'
import { Claim } from '../../../index.js'
import { OidcAuthenticationHandler } from './handler.js'
import { accessTokenHash } from './_at_hash.js'
import type { OidcAuthenticationOptions } from './options.js'
import { encodeSession, claimsToSession } from './session_store.js'
import { encodeState } from './state_store.js'

const SESSION_SECRET = 'test-session-secret-at-least-32-chars!!'
const CLIENT_ID = 'test-client-id'
const ISSUER = 'https://accounts.example.com'
const CALLBACK_URL = 'https://app.example.com/auth/callback'
const CALLBACK_PATH = '/auth/callback'

function makeBaseOptions(overrides: Partial<OidcAuthenticationOptions> = {}): OidcAuthenticationOptions {
  return {
    clientId: CLIENT_ID,
    clientSecret: 'test-client-secret',
    discoveryUrl: ISSUER,
    callbackUrl: CALLBACK_URL,
    sessionSecret: SESSION_SECRET,
    sessionCookieName: '__oidc_session',
    sessionCookieTtlSeconds: 3600,
    stateCookieName: '__oidc_state',
    defaultRedirectPath: '/',
    scopes: ['openid', 'profile', 'email'],
    secureCookie: false,
    ...overrides,
  }
}

function makeCtx(overrides: Partial<{
  url: string
  cookies: Record<string, string>
  query: Record<string, string>
}> = {}): { ctx: Context, cookie: ReturnType<typeof vi.fn>, deleteCookie: ReturnType<typeof vi.fn>, redirect: ReturnType<typeof vi.fn>, status: ReturnType<typeof vi.fn> } {
  const cookies = overrides.cookies ?? {}
  const query = overrides.query ?? {}
  const cookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const redirect = vi.fn().mockReturnThis()
  const status = vi.fn().mockReturnThis()

  const ctx = {
    req: {
      url: overrides.url ?? '/dashboard',
      cookie: (name?: string) => name === undefined ? cookies : cookies[name],
      query: (key?: string) => key === undefined ? query : query[key],
      header: () => undefined,
    },
    cookie,
    deleteCookie,
    redirect,
    status,
  } as unknown as Context

  return { ctx, cookie, deleteCookie, redirect, status }
}

const DISCOVERY_DOCUMENT = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  code_challenge_methods_supported: ['S256', 'plain'],
}

describe('OidcAuthenticationHandler', () => {
  describe('authenticate() — session validation', () => {
    it('returns none() when no session cookie', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx()
      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns success with correct principal when session cookie is valid', async () => {
      const claims = [new Claim('sub', 'user1', ISSUER), new Claim('email', 'u@x.com', ISSUER)]
      const session = claimsToSession(claims, 'OIDC')
      const jwt = await encodeSession(session, SESSION_SECRET, 3600)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx({ cookies: { __oidc_session: jwt } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe('user1')
      expect(result.ticket!.principal.findFirst('email')?.value).toBe('u@x.com')
    })

    it('returns fail() when session cookie is expired or tampered', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx({ cookies: { __oidc_session: 'invalid.jwt.token' } })
      const result = await handler.authenticate(ctx)

      // A presented-but-invalid credential is a failure, not an absent one.
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns fail() when a state cookie is replayed as a session cookie', async () => {
      const stateJwt = await encodeState(
        { state: 's', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/' },
        SESSION_SECRET,
      )
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx({ cookies: { __oidc_session: stateJwt } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error?.message).toMatch(/typ/i)
    })

    it('fires onFail with the error when the session cookie is invalid', async () => {
      const onFail = vi.fn()
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ onFail }))
      const { ctx } = makeCtx({ cookies: { __oidc_session: 'invalid.jwt.token' } })

      await handler.authenticate(ctx)

      expect(onFail).toHaveBeenCalledOnce()
      const [, error] = onFail.mock.calls[0] as [unknown, Error]
      expect(error).toBeInstanceOf(Error)
    })

    it('does not fire onFail when no session cookie is present', async () => {
      const onFail = vi.fn()
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ onFail }))
      const { ctx } = makeCtx()

      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
      expect(onFail).not.toHaveBeenCalled()
    })
  })

  describe('challenge()', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(DISCOVERY_DOCUMENT),
      }))
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('redirects to provider authorization URL', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, redirect } = makeCtx({ url: '/protected' })
      await handler.challenge(ctx)

      expect(redirect).toHaveBeenCalledOnce()
      const [url, status] = redirect.mock.calls[0] as [string, number]
      expect(status).toBe(302)
      expect(url).toContain(`${ISSUER}/auth`)
    })

    it('authorization URL contains required OAuth params', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, redirect } = makeCtx({ url: '/protected' })
      await handler.challenge(ctx)

      const [url] = redirect.mock.calls[0] as [string, number]
      const parsed = new URL(url)
      expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID)
      expect(parsed.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
      expect(parsed.searchParams.get('response_type')).toBe('code')
      expect(parsed.searchParams.get('scope')).toContain('openid')
      expect(parsed.searchParams.get('state')).toBeTruthy()
      expect(parsed.searchParams.get('nonce')).toBeTruthy()
      expect(parsed.searchParams.get('code_challenge')).toBeTruthy()
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    })

    it('sets state cookie on context', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, cookie } = makeCtx()
      await handler.challenge(ctx)

      expect(cookie).toHaveBeenCalledOnce()
      const [name, , opts] = cookie.mock.calls[0] as [string, string, Record<string, unknown>]
      expect(name).toBe('__oidc_state')
      expect(opts.httpOnly).toBe(true)
      expect(opts.sameSite).toBe('lax')
    })

    it('rejects a provider that advertises only plain pkce', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, code_challenge_methods_supported: ['plain'] }),
      }))

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx()

      await expect(handler.challenge(ctx)).rejects.toThrow('enable allowPlainPkce')
    })

    it('uses plain pkce when discovery only lists plain and it is explicitly allowed', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, code_challenge_methods_supported: ['plain'] }),
      }))

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ allowPlainPkce: true }))
      const { ctx, redirect } = makeCtx()
      await handler.challenge(ctx)

      const [url] = redirect.mock.calls[0] as [string]
      expect(new URL(url).searchParams.get('code_challenge_method')).toBe('plain')
    })

    it('throws when the discovery issuer does not match the configured issuer', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, issuer: 'https://attacker.example.com' }),
      }))

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ issuer: ISSUER }))
      const { ctx } = makeCtx()

      await expect(handler.challenge(ctx)).rejects.toThrow('does not match the configured issuer')
    })

    it('hands the authorization URL to onChallenge instead of redirecting', async () => {
      const onChallenge = vi.fn()
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ onChallenge }))
      const { ctx, redirect, cookie } = makeCtx()

      await handler.challenge(ctx)

      expect(redirect).not.toHaveBeenCalled()
      expect(onChallenge).toHaveBeenCalledOnce()

      const [, url] = onChallenge.mock.calls[0] as [unknown, string]
      const parsed = new URL(url)
      expect(parsed.searchParams.get('state')).toBeTruthy()
      expect(parsed.searchParams.get('nonce')).toBeTruthy()
      expect(parsed.searchParams.get('code_challenge')).toBeTruthy()

      // The state cookie must still be set — the hook shapes the response, it does not
      // replace the flow.
      expect(cookie).toHaveBeenCalledOnce()
      expect((cookie.mock.calls[0] as [string])[0]).toBe('__oidc_state')
    })

    it('stores returnTo (current URL) in state cookie', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, cookie } = makeCtx({ url: '/dashboard?tab=settings' })
      await handler.challenge(ctx)

      const [, stateCookieJwt] = cookie.mock.calls[0] as [string, string]
      const { decodeState } = await import('./state_store.js')
      const stored = await decodeState(stateCookieJwt, SESSION_SECRET)
      expect(stored.returnTo).toBe('/dashboard?tab=settings')
    })
  })

  describe('secure cookie resolution', () => {
    // Constructs the handler directly from a raw options object, bypassing the builder —
    // the path where a fail-open default would actually bite.
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(DISCOVERY_DOCUMENT),
      }))
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function secureFlagFor(options: OidcAuthenticationOptions) {
      const handler = new OidcAuthenticationHandler('OIDC', options)
      const { ctx, cookie } = makeCtx()
      await handler.challenge(ctx)

      const [, , opts] = cookie.mock.calls[0] as [string, string, Record<string, unknown>]
      return opts.secure
    }

    function withoutSecureCookie(callbackUrl: string): OidcAuthenticationOptions {
      const opts = makeBaseOptions({ callbackUrl })
      delete opts.secureCookie
      return opts
    }

    it('defaults to secure when secureCookie is omitted and callbackUrl is https', async () => {
      expect(await secureFlagFor(withoutSecureCookie('https://app.example.com/cb'))).toBe(true)
    })

    it('defaults to non-secure when secureCookie is omitted and callbackUrl is http', async () => {
      expect(await secureFlagFor(withoutSecureCookie('http://localhost:3000/cb'))).toBe(false)
    })

    it('honours an explicit secureCookie override on an http callback', async () => {
      const opts = makeBaseOptions({ callbackUrl: 'http://localhost:3000/cb', secureCookie: true })
      expect(await secureFlagFor(opts)).toBe(true)
    })
  })

  describe('revoke()', () => {
    it('clears the session cookie so the user is signed out', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, deleteCookie } = makeCtx()

      await handler.revoke(ctx)

      expect(deleteCookie).toHaveBeenCalledOnce()
      const [name] = deleteCookie.mock.calls[0] as [string]
      expect(name).toBe('__oidc_session')
    })
  })

  describe('roleClaimType', () => {
    it('passes the configured role claim type through to the identity', async () => {
      const claims = [new Claim('groups', ['admin'], ISSUER)]
      const session = claimsToSession(claims, 'OIDC')
      const jwt = await encodeSession(session, SESSION_SECRET, 3600)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ roleClaimType: 'groups' }))
      const { ctx } = makeCtx({ cookies: { __oidc_session: jwt } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.isInRole('admin')).toBe(true)
    })
  })

  describe('forbid()', () => {
    it('sets 403 by default', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, status } = makeCtx()

      await handler.forbid(ctx)
      expect(status).toHaveBeenCalledWith(403)
    })

    it('delegates to onForbid when provided', async () => {
      const onForbid = vi.fn()
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ onForbid }))
      const { ctx, status } = makeCtx()

      await handler.forbid(ctx)

      expect(onForbid).toHaveBeenCalledOnce()
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('processCallback()', () => {
    let privateKey: KeyLike
    let jwksResolver: (uri: string) => JWTVerifyGetKey

    beforeEach(async () => {
      const pair = await generateKeyPair('RS256')
      privateKey = pair.privateKey
      const jwk = await exportJWK(pair.publicKey)
      const localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] })
      jwksResolver = () => localJwks as JWTVerifyGetKey
    })

    async function signIdToken(nonce: string, extraClaims: Record<string, unknown> = {}) {
      return new SignJWT({ sub: 'user123', email: 'user@example.com', nonce, ...extraClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setExpirationTime('1h')
        .sign(privateKey)
    }

    function mockFetch(nonce: string, extraClaims: Record<string, unknown> = {}) {
      vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('.well-known')) {
          return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
        }
        if (opts?.method === 'POST') {
          const idToken = await signIdToken(nonce, extraClaims)
          return { ok: true, json: () => Promise.resolve({ id_token: idToken, access_token: 'at' }) }
        }
        return { ok: false, status: 404 }
      }))
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function makeStateCookie(nonce: string, state = 'st') {
      return encodeState(
        { state, nonce, codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/dashboard' },
        SESSION_SECRET,
      )
    }

    describe('authorization error response', () => {
      it('reports the provider error rather than a missing code', async () => {
        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          url: CALLBACK_PATH,
          query: { error: 'access_denied', error_description: 'User denied consent' },
        })

        const promise = handler.processCallback(ctx)
        await expect(promise).rejects.toThrow('provider returned "access_denied"')
        await expect(promise).rejects.toThrow('User denied consent')
        // The old behaviour misdiagnosed this as a missing code.
        await expect(promise).rejects.not.toThrow('missing code parameter')
      })

      it('reports an error with no description', async () => {
        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({ url: CALLBACK_PATH, query: { error: 'server_error' } })

        await expect(handler.processCallback(ctx)).rejects.toThrow('provider returned "server_error"')
      })
    })

    describe('RFC 9207 iss validation', () => {
      it('rejects an iss that is not the provider issuer', async () => {
        const nonce = 'iss-nonce'
        const stateCookieJwt = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st', iss: 'https://attacker.example.com' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('iss does not match')
      })

      it('accepts a matching iss', async () => {
        const nonce = 'iss-ok'
        const stateCookieJwt = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st', iss: ISSUER },
        })

        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })

      it('accepts an absent iss, which most providers still omit', async () => {
        const nonce = 'iss-absent'
        const stateCookieJwt = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })
    })

    it('sets session cookie and redirects on successful callback', async () => {
      const nonce = 'test-nonce'
      const stateCookieJwt = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx, cookie, redirect } = makeCtx({
        url: CALLBACK_PATH + '?code=auth-code&state=st',
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'auth-code', state: 'st' },
      })

      await handler.processCallback(ctx)

      expect(cookie).toHaveBeenCalledOnce()
      const [name, , opts] = cookie.mock.calls[0] as [string, string, Record<string, unknown>]
      expect(name).toBe('__oidc_session')
      expect(opts.httpOnly).toBe(true)

      expect(redirect).toHaveBeenCalledWith('/dashboard', 302)
    })

    it('deletes state cookie during callback', async () => {
      const nonce = 'n1'
      const stateCookieJwt = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx, deleteCookie } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'code', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(deleteCookie).toHaveBeenCalledWith('__oidc_state', expect.any(Object))
    })

    it('throws when code query param is missing', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({ url: CALLBACK_PATH, query: { state: 'st' } })
      await expect(handler.processCallback(ctx)).rejects.toThrow('missing code parameter')
    })

    it('throws when state cookie is missing', async () => {
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({ url: CALLBACK_PATH, query: { code: 'c', state: 'st' } })
      await expect(handler.processCallback(ctx)).rejects.toThrow('missing state cookie')
    })

    it('throws when state param does not match stored state', async () => {
      const stateCookieJwt = await encodeState(
        { state: 'correct', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/' },
        SESSION_SECRET,
      )
      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'wrong' },
      })
      await expect(handler.processCallback(ctx)).rejects.toThrow('state mismatch')
    })

    it('throws when nonce in id_token does not match stored nonce', async () => {
      const stateCookieJwt = await makeStateCookie('correct-nonce')
      mockFetch('wrong-nonce')

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('nonce mismatch')
    })

    it('fires onFail when the callback fails, then rethrows', async () => {
      const onFail = vi.fn()
      const stateCookieJwt = await makeStateCookie('correct-nonce')
      mockFetch('wrong-nonce')

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onFail }))
      const { ctx } = makeCtx({
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('nonce mismatch')

      expect(onFail).toHaveBeenCalledOnce()
      const [, error] = onFail.mock.calls[0] as [unknown, Error]
      expect(error.message).toContain('nonce mismatch')
    })

    it('does not fire onFail on a successful callback', async () => {
      const onFail = vi.fn()
      const nonce = 'ok-nonce'
      const stateCookieJwt = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onFail }))
      const { ctx } = makeCtx({
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(onFail).not.toHaveBeenCalled()
    })

    describe('token exposure', () => {
      function mockFullTokenResponse(nonce: string, extra: Record<string, unknown> = {}) {
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            const idToken = await signIdToken(nonce)
            return {
              ok: true,
              json: () => Promise.resolve({
                id_token: idToken,
                access_token: 'the-access-token',
                refresh_token: 'the-refresh-token',
                token_type: 'Bearer',
                expires_in: 3599,
                scope: 'openid email',
                ...extra,
              }),
            }
          }
          return { ok: false, status: 404 }
        }))
      }

      it('hands the full token set to onTokenValidated', async () => {
        const onTokenValidated = vi.fn()
        const nonce = 'tokens-nonce'
        const stateCookieJwt = await makeStateCookie(nonce)
        mockFullTokenResponse(nonce)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onTokenValidated }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)

        const [, , tokens] = onTokenValidated.mock.calls[0] as [unknown, unknown, Record<string, unknown>]
        expect(tokens.accessToken).toBe('the-access-token')
        expect(tokens.refreshToken).toBe('the-refresh-token')
        expect(tokens.tokenType).toBe('Bearer')
        expect(tokens.expiresIn).toBe(3599)
        expect(tokens.scope).toBe('openid email')
        expect(typeof tokens.idToken).toBe('string')
      })

      it('never writes the tokens into the session cookie', async () => {
        const nonce = 'no-leak-nonce'
        const stateCookieJwt = await makeStateCookie(nonce)
        mockFullTokenResponse(nonce)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx, cookie } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)

        const [, sessionJwt] = cookie.mock.calls[0] as [string, string]
        // Refresh tokens are long-lived credentials and the cookie is client-side.
        expect(sessionJwt).not.toContain('the-refresh-token')
        expect(sessionJwt).not.toContain('the-access-token')

        const { decodeSession } = await import('./session_store.js')
        const session = await decodeSession(sessionJwt, SESSION_SECRET)
        expect(JSON.stringify(session)).not.toContain('the-refresh-token')
        expect(JSON.stringify(session)).not.toContain('the-access-token')
      })

      it('rejects an id_token whose at_hash does not bind the access token', async () => {
        const nonce = 'at-hash-bad'
        const stateCookieJwt = await makeStateCookie(nonce)
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            const idToken = await signIdToken(nonce, { at_hash: accessTokenHash('a-different-token', 'RS256') })
            return { ok: true, json: () => Promise.resolve({ id_token: idToken, access_token: 'the-access-token' }) }
          }
          return { ok: false, status: 404 }
        }))

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('at_hash does not match')
      })

      it('accepts an id_token whose at_hash binds the access token', async () => {
        const nonce = 'at-hash-ok'
        const stateCookieJwt = await makeStateCookie(nonce)
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            const idToken = await signIdToken(nonce, { at_hash: accessTokenHash('the-access-token', 'RS256') })
            return { ok: true, json: () => Promise.resolve({ id_token: idToken, access_token: 'the-access-token' }) }
          }
          return { ok: false, status: 404 }
        }))

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })
    })

    describe('token endpoint client authentication', () => {
      async function exchangeWith(
        options: Partial<OidcAuthenticationOptions>,
        discovery: Record<string, unknown> = DISCOVERY_DOCUMENT,
      ) {
        const nonce = 'auth-nonce'
        const stateCookieJwt = await makeStateCookie(nonce)
        const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(discovery) }
          }
          if (opts?.method === 'POST') {
            const idToken = await signIdToken(nonce)
            return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
          }
          return { ok: false, status: 404 }
        })
        vi.stubGlobal('fetch', fetchMock)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, ...options }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })
        await handler.processCallback(ctx)

        const post = fetchMock.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
        )!
        const init = post[1] as RequestInit
        return {
          headers: init.headers as Record<string, string>,
          body: (init.body as URLSearchParams),
        }
      }

      it('defaults to Basic and keeps credentials out of the body', async () => {
        const { headers, body } = await exchangeWith({})

        expect(headers.Authorization).toMatch(/^Basic /)
        expect(body.get('client_id')).toBeNull()
        expect(body.get('client_secret')).toBeNull()
        expect(body.get('code_verifier')).toBe('cv')
      })

      it('form-urlencodes the credentials before base64, per RFC 6749 §2.3.1', async () => {
        // encodeURIComponent leaves !~'() alone; the form serializer does not.
        const secret = 's3cret:with+odd ~chars!\'()'
        const { headers } = await exchangeWith({ clientSecret: secret })

        const decoded = Buffer.from(headers.Authorization.slice('Basic '.length), 'base64').toString()
        const [user, pass] = decoded.split(':')
        expect(user).toBe(CLIENT_ID)
        expect(pass).toBe(new URLSearchParams({ v: secret }).toString().slice(2))
        // A space must be "+", never "%20", under form-urlencoding.
        expect(pass).toContain('+')
        expect(pass).not.toContain('%20')
      })

      it('sends credentials in the body when configured for post', async () => {
        const { headers, body } = await exchangeWith({ tokenEndpointAuthMethod: 'client_secret_post' })

        expect(headers.Authorization).toBeUndefined()
        expect(body.get('client_id')).toBe(CLIENT_ID)
        expect(body.get('client_secret')).toBe('test-client-secret')
      })

      it('auto-selects post when the provider advertises only post', async () => {
        const { headers, body } = await exchangeWith({}, {
          ...DISCOVERY_DOCUMENT,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        })

        expect(headers.Authorization).toBeUndefined()
        expect(body.get('client_secret')).toBe('test-client-secret')
      })

      it('auto-selects basic when the provider advertises both', async () => {
        const { headers } = await exchangeWith({}, {
          ...DISCOVERY_DOCUMENT,
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        })

        expect(headers.Authorization).toMatch(/^Basic /)
      })

      it('throws when the provider advertises neither basic nor post', async () => {
        await expect(exchangeWith({}, {
          ...DISCOVERY_DOCUMENT,
          token_endpoint_auth_methods_supported: ['private_key_jwt'],
        })).rejects.toThrow('supports neither client_secret_basic nor client_secret_post')
      })
    })

    describe('id_token claim validation', () => {
      it('rejects an id_token without a sub claim', async () => {
        const nonce = 'no-sub'
        const stateCookieJwt = await makeStateCookie(nonce)
        // signIdToken always sets sub, so sign one explicitly without it.
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            const idToken = await new SignJWT({ email: 'u@x.com', nonce })
              .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
              .setIssuer(ISSUER)
              .setAudience(CLIENT_ID)
              .setExpirationTime('1h')
              .sign(privateKey)
            return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
          }
          return { ok: false, status: 404 }
        }))

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('missing the sub claim')
      })

      async function callbackWithAudience(aud: string[], azp?: string) {
        const nonce = 'aud-nonce'
        const stateCookieJwt = await makeStateCookie(nonce)
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            const idToken = await new SignJWT({
              sub: 'u1',
              nonce,
              ...(azp !== undefined ? { azp } : {}),
            })
              .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
              .setIssuer(ISSUER)
              .setAudience(aud)
              .setExpirationTime('1h')
              .sign(privateKey)
            return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
          }
          return { ok: false, status: 404 }
        }))

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })
        return handler.processCallback(ctx)
      }

      it('rejects multiple audiences with no azp claim', async () => {
        await expect(callbackWithAudience([CLIENT_ID, 'other'])).rejects.toThrow('no azp claim')
      })

      it('rejects multiple audiences whose azp is another client', async () => {
        await expect(callbackWithAudience([CLIENT_ID, 'other'], 'other'))
          .rejects.toThrow('azp does not match clientId')
      })

      it('accepts multiple audiences when azp matches this client', async () => {
        await expect(callbackWithAudience([CLIENT_ID, 'other'], CLIENT_ID)).resolves.toBeUndefined()
      })
    })

    it('throws when the token endpoint returns a non-ok status with no error body', async () => {
      const nonce = 'bad-status'
      const stateCookieJwt = await makeStateCookie(nonce)
      vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('.well-known')) {
          return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
        }
        if (opts?.method === 'POST') {
          return { ok: false, status: 503, json: () => Promise.reject(new Error('not json')) }
        }
        return { ok: false, status: 404 }
      }))

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('token endpoint returned 503')
    })

    it('calls onTokenValidated hook with id_token payload', async () => {
      const onTokenValidated = vi.fn()
      const nonce = 'hook-nonce'
      const stateCookieJwt = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onTokenValidated }))
      const { ctx } = makeCtx({
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(onTokenValidated).toHaveBeenCalledOnce()
      const [, payload] = onTokenValidated.mock.calls[0] as [unknown, Record<string, unknown>]
      expect(payload.sub).toBe('user123')
      expect(payload.nonce).toBe(nonce)
    })

    it('excludes registered JWT claims from the default claim mapping', async () => {
      const nonce = 'registered-nonce'
      const stateCookieJwt = await makeStateCookie(nonce)
      mockFetch(nonce, { groups: ['admin'] })

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx, cookie } = makeCtx({
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)

      const [, sessionJwt] = cookie.mock.calls[0] as [string, string]
      const { decodeSession } = await import('./session_store.js')
      const session = await decodeSession(sessionJwt, SESSION_SECRET)
      const types = session.claims.map(c => c.type)

      // User claims survive.
      expect(types).toContain('sub')
      expect(types).toContain('email')
      expect(types).toContain('groups')

      // Token metadata must not leak into the principal.
      for (const registered of ['iss', 'aud', 'exp', 'iat', 'nonce', 'typ']) {
        expect(types).not.toContain(registered)
      }
    })

    describe('returnTo open-redirect guard', () => {
      async function callbackWithReturnTo(returnTo: string) {
        const nonce = 'redirect-nonce'
        const stateCookieJwt = await encodeState(
          { state: 'st', nonce, codeVerifier: 'cv', pkceMethod: 'S256', returnTo },
          SESSION_SECRET,
        )
        mockFetch(nonce)

        const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx, redirect } = makeCtx({
          cookies: { __oidc_state: stateCookieJwt },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)
        return (redirect.mock.calls[0] as [string, number])[0]
      }

      it('allows a same-site absolute path', async () => {
        expect(await callbackWithReturnTo('/dashboard?tab=1')).toBe('/dashboard?tab=1')
      })

      it('rejects a protocol-relative URL', async () => {
        expect(await callbackWithReturnTo('//evil.com/phish')).toBe('/')
      })

      it('rejects a backslash-escaped protocol-relative URL', async () => {
        expect(await callbackWithReturnTo('/\\evil.com')).toBe('/')
      })

      it('rejects an absolute off-site URL', async () => {
        expect(await callbackWithReturnTo('https://evil.com/phish')).toBe('/')
      })
    })

    it('uses claimMapper when provided', async () => {
      const claimMapper = vi.fn().mockReturnValue([new Claim('mapped', 'value', 'iss')])
      const nonce = 'mapper-nonce'
      const stateCookieJwt = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OidcAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, claimMapper }))
      const { ctx, cookie } = makeCtx({
        cookies: { __oidc_state: stateCookieJwt },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(claimMapper).toHaveBeenCalledOnce()
      const [, sessionJwt] = cookie.mock.calls[0] as [string, string]
      const { decodeSession } = await import('./session_store.js')
      const session = await decodeSession(sessionJwt, SESSION_SECRET)
      expect(session.claims[0].type).toBe('mapped')
    })
  })
})
