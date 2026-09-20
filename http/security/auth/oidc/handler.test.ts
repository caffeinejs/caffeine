import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import type { JWTVerifyGetKey, CryptoKey } from 'jose'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { decodeSession, encodeSession, claimsToSession } from '../internal/remote/session_store.js'
import { encodeState } from '../internal/remote/state_store.js'
import { accessTokenHash } from './_at_hash.js'
import { OIDCAuthenticationHandler } from './handler.js'
import type { OIDCAuthenticationOptions } from './options.js'

/** The strategy name these handlers are registered under; cookies are sealed per scheme. */
const SCHEME = 'OIDC'

const SESSION_SECRET = 'test-session-secret-at-least-32-chars!!'
const CLIENT_ID = 'test-client-id'
const ISSUER = 'https://accounts.example.com'
const CALLBACK_URL = 'https://app.example.com/auth/callback'
const CALLBACK_PATH = '/auth/callback'

function makeBaseOptions(overrides: Partial<OIDCAuthenticationOptions> = {}): OIDCAuthenticationOptions {
  return {
    clientID: CLIENT_ID,
    clientSecret: 'test-client-secret',
    discoveryURL: ISSUER,
    issuer: ISSUER,
    callbackURL: CALLBACK_URL,
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

function makeCtx(
  overrides: Partial<{
    url: string
    cookies: Record<string, string>
    query: Record<string, string>
    headers: Record<string, string>
  }> = {},
): {
  ctx: Context
  cookie: ReturnType<typeof vi.fn>
  deleteCookie: ReturnType<typeof vi.fn>
  redirect: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  header: ReturnType<typeof vi.fn>
  body: ReturnType<typeof vi.fn>
} {
  const cookies = overrides.cookies ?? {}
  const query = overrides.query ?? {}
  // A browser navigation by default, because that is what a sign-in is: it keeps every test whose subject is
  // the authorization URL on the redirect branch, so only the tests about the challenge switch itself opt out.
  const headers = overrides.headers ?? { 'sec-fetch-mode': 'navigate' }
  const cookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const redirect = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()
  const status = vi.fn(() => ctx)
  const body = vi.fn().mockReturnThis()

  const ctx = {
    req: {
      url: overrides.url ?? '/dashboard',
      cookie: (name?: string) => (name === undefined ? cookies : cookies[name]),
      query: (key?: string) => (key === undefined ? query : query[key]),
      header: (name?: string) => (name === undefined ? headers : headers[name]),
    },
    cookie,
    deleteCookie,
    redirect,
    status,
    header,
    body,
  } as unknown as Context

  return { ctx, cookie, deleteCookie, redirect, status, header, body }
}

const DISCOVERY_DOCUMENT = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  code_challenge_methods_supported: ['S256', 'plain'],
}

describe('OIDCAuthenticationHandler', () => {
  describe('authenticate() — session validation', () => {
    it('returns none() when no session cookie', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx()
      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns success with correct principal when session cookie is valid', async () => {
      const claims = [new Claim('sub', 'user1', ISSUER), new Claim('email', 'u@x.com', ISSUER)]
      const session = claimsToSession(claims, 'OIDC')
      const jwt = await encodeSession(session, SESSION_SECRET, SCHEME, 3600)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx({ cookies: { __oidc_session: jwt } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe('user1')
      expect(result.ticket!.principal.findFirst('email')?.value).toBe('u@x.com')
    })

    it('returns fail() when session cookie is expired or tampered', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx({ cookies: { __oidc_session: 'invalid.jwt.token' } })
      const result = await handler.authenticate(ctx)

      // A presented-but-invalid credential is a failure, not an absent one.
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns fail() when a state cookie is replayed as a session cookie', async () => {
      const stateJWT = await encodeState(
        {
          state: 's',
          nonce: 'n',
          codeVerifier: 'cv',
          pkceMethod: 'S256',
          returnTo: '/',
          scheme: SCHEME,
          issuer: ISSUER,
        },
        SESSION_SECRET,
        SCHEME,
      )
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx({ cookies: { __oidc_session: stateJWT } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error?.message).toMatch(/typ/i)
    })

    it('fires onFail with the error when the session cookie is invalid', async () => {
      const onFail = vi.fn()
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onFail }))
      const { ctx } = makeCtx({ cookies: { __oidc_session: 'invalid.jwt.token' } })

      await handler.authenticate(ctx)

      expect(onFail).toHaveBeenCalledOnce()
      const [, error] = onFail.mock.calls[0] as [unknown, Error]
      expect(error).toBeInstanceOf(Error)
    })

    it('does not fire onFail when no session cookie is present', async () => {
      const onFail = vi.fn()
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onFail }))
      const { ctx } = makeCtx()

      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
      expect(onFail).not.toHaveBeenCalled()
    })
  })

  describe('challenge()', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(DISCOVERY_DOCUMENT),
        }),
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('redirects to provider authorization URL', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, redirect } = makeCtx({ url: '/protected' })
      await handler.challenge(ctx)

      expect(redirect).toHaveBeenCalledOnce()
      const [url, status] = redirect.mock.calls[0] as [string, number]
      expect(status).toBe(302)
      expect(url).toContain(`${ISSUER}/auth`)
    })

    it('authorization URL contains required OAuth params', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
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
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, cookie } = makeCtx()
      await handler.challenge(ctx)

      expect(cookie).toHaveBeenCalledOnce()
      const [name, , opts] = cookie.mock.calls[0] as [string, string, Record<string, unknown>]
      // Named per flow: the suffix is this challenge's own `state`, so concurrent sign-ins do not collide.
      expect(name).toMatch(/^__oidc_state\.[A-Za-z0-9_-]+$/)
      expect(opts.httpOnly).toBe(true)
      expect(opts.sameSite).toBe('lax')
    })

    it('rejects a provider that advertises only plain pkce', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, code_challenge_methods_supported: ['plain'] }),
        }),
      )

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx } = makeCtx()

      await expect(handler.challenge(ctx)).rejects.toThrow('enable allowPlainPKCE')
    })

    it('uses plain pkce when discovery only lists plain and it is explicitly allowed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, code_challenge_methods_supported: ['plain'] }),
        }),
      )

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ allowPlainPKCE: true }))
      const { ctx, redirect } = makeCtx()
      await handler.challenge(ctx)

      const [url] = redirect.mock.calls[0] as [string]
      expect(new URL(url).searchParams.get('code_challenge_method')).toBe('plain')
    })

    it('throws when the discovery issuer does not match the configured issuer', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, issuer: 'https://attacker.example.com' }),
        }),
      )

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ issuer: ISSUER }))
      const { ctx } = makeCtx()

      await expect(handler.challenge(ctx)).rejects.toThrow('does not match the configured issuer')
    })

    it('hands the authorization URL to onChallenge instead of redirecting', async () => {
      const onChallenge = vi.fn()
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onChallenge }))
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
      expect((cookie.mock.calls[0] as [string])[0]).toMatch(/^__oidc_state\./)
    })

    /**
     * A redirect to the provider is something only a browser navigation can follow: `fetch` follows it itself,
     * lands cross-origin on a provider that sends no CORS headers, and the caller sees a network error rather
     * than "you are not signed in". So the challenge picks its response from what the caller looks like.
     */
    describe('challenge mode', () => {
      const authorizationURL = (header: ReturnType<typeof vi.fn>) =>
        (header.mock.calls.find(([name]) => name === 'location') as [string, string] | undefined)?.[1]

      // Where to send the browser, on this origin and absolute, so a page served from another origin can use it.
      it('answers 401 with the sign-in URL of this origin when the caller is not a navigation', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, redirect, status, header } = makeCtx({
          url: '/reports?tab=1',
          headers: { accept: 'application/json' },
        })

        await handler.challenge(ctx)

        expect(redirect).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(401)
        expect(authorizationURL(header)).toBe(
          `https://app.example.com${CALLBACK_PATH}/login?returnTo=${encodeURIComponent('/reports?tab=1')}`,
        )
      })

      // A page that polls while signed out is challenged on every poll. A state cookie each, good for ten minutes,
      // outgrows the request headers a server accepts; and a provider that is down has nothing to do with saying 401.
      it('starts nothing for a 401: no state cookie, and the provider is not asked', async () => {
        const fetched = vi.fn()
        vi.stubGlobal('fetch', fetched)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, cookie } = makeCtx({ headers: {} })

        await handler.challenge(ctx)

        expect(cookie).not.toHaveBeenCalled()
        expect(fetched).not.toHaveBeenCalled()
      })

      /**
       * The hook shapes the response, and the response it shapes for a caller that cannot follow a redirect is
       * "go to the sign-in page". A flow started for that caller is one nobody spends: the browser goes to
       * `loginPath`, and `startSignIn` mints a fresh one there.
       */
      describe('with an onChallenge hook', () => {
        it('starts nothing for a caller that cannot follow a redirect, and hands it the sign-in URL', async () => {
          const fetched = vi.fn()
          vi.stubGlobal('fetch', fetched)

          const onChallenge = vi.fn()
          const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onChallenge }))
          const { ctx, cookie } = makeCtx({ url: '/reports?tab=1', headers: { accept: 'application/json' } })

          await handler.challenge(ctx)

          expect(cookie).not.toHaveBeenCalled()
          expect(fetched).not.toHaveBeenCalled()
          expect(onChallenge).toHaveBeenCalledWith(
            ctx,
            `https://app.example.com${CALLBACK_PATH}/login?returnTo=${encodeURIComponent('/reports?tab=1')}`,
          )
        })

        // A page polling while signed out is challenged on every poll. Once the outstanding flows reach the
        // cap they are all cleared, so a handful of polls used to take out the sign-in the user had under way
        // in another tab: that tab came back from the provider to a state cookie no longer there.
        it('does not clear the flows another tab has under way', async () => {
          const onChallenge = vi.fn()
          const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onChallenge }))
          const outstanding = Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [`__oidc_state.state${index}`, 'sealed']),
          )
          const { ctx, cookie, deleteCookie } = makeCtx({
            cookies: outstanding,
            headers: { accept: 'application/json' },
          })

          await handler.challenge(ctx)

          expect(deleteCookie).not.toHaveBeenCalled()
          expect(cookie).not.toHaveBeenCalled()
        })
      })

      it('leaves a way back that would leave this origin out of the sign-in URL', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, header } = makeCtx({ headers: {} })

        await handler.challenge(ctx, { redirectURI: '//evil.example/steal' })

        expect(authorizationURL(header)).toBe(`https://app.example.com${CALLBACK_PATH}/login`)
      })

      it('redirects a caller that asks for HTML, for browsers that send no sec-fetch headers', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, redirect } = makeCtx({ headers: { accept: 'text/html,application/xhtml+xml' } })

        await handler.challenge(ctx)

        expect(redirect).toHaveBeenCalledOnce()
      })

      it('redirects on sec-fetch-dest: document as well as sec-fetch-mode: navigate', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, redirect } = makeCtx({ headers: { 'sec-fetch-dest': 'document' } })

        await handler.challenge(ctx)

        expect(redirect).toHaveBeenCalledOnce()
      })

      it('answers 401 to a caller that sends no hint at all', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, redirect, status } = makeCtx({ headers: {} })

        await handler.challenge(ctx)

        expect(redirect).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(401)
      })

      // Fetch Metadata says "not a navigation", and that must win over Accept. htmx sends exactly this
      // pair; redirecting it lands a cross-origin provider response the caller can only see as an opaque
      // network error, which is the failure `auto` exists to prevent.
      it('does not redirect a cors request that also accepts HTML', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, redirect, status } = makeCtx({
          headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'text/html' },
        })

        await handler.challenge(ctx)

        expect(redirect).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(401)
      })

      // Browsers omit Fetch Metadata outside secure contexts, so plain-http development relies on Accept.
      it('falls back to Accept when Fetch Metadata is absent', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx, redirect } = makeCtx({ headers: { accept: 'text/html,application/xhtml+xml' } })

        await handler.challenge(ctx)

        expect(redirect).toHaveBeenCalledOnce()
      })

      // `Location` is not CORS-safelisted, so a SPA on another origin than its API — the deployment
      // `status` exists for — could not read the URL out of the header it was returned in.
      it('puts the sign-in URL in the body, not only the Location header', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ challengeMode: 'status' }))
        const { ctx, body, header } = makeCtx({ headers: {} })

        await handler.challenge(ctx)

        const [payload] = body.mock.calls[0] as [{ error: string; loginURL: string }]
        expect(payload.error).toBe('authentication_required')
        expect(payload.loginURL).toBe(
          `https://app.example.com${CALLBACK_PATH}/login?returnTo=${encodeURIComponent('/dashboard')}`,
        )
        expect(header).toHaveBeenCalledWith('access-control-expose-headers', 'location')
      })

      // Two tabs starting a sign-in against the same provider used to share one fixed cookie name, so the
      // second challenge overwrote the first's state and the first callback died with "state mismatch" —
      // a flow the user started, killed by an unrelated one.
      it('gives concurrent sign-ins their own state cookie', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())

        const first = makeCtx({ headers: { 'sec-fetch-mode': 'navigate' } })
        const second = makeCtx({ headers: { 'sec-fetch-mode': 'navigate' } })
        await handler.challenge(first.ctx)
        await handler.challenge(second.ctx)

        const nameOf = (c: typeof first) => (c.cookie.mock.calls[0] as [string])[0]
        expect(nameOf(first)).not.toBe(nameOf(second))

        // Each name carries the state its own authorization URL sent, which is what lets the callback pick
        // the right one out of a jar holding both.
        const stateOf = (c: typeof first) =>
          new URL((c.redirect.mock.calls[0] as [string])[0]).searchParams.get('state')
        expect(nameOf(first)).toBe(`__oidc_state.${stateOf(first)}`)
        expect(nameOf(second)).toBe(`__oidc_state.${stateOf(second)}`)
      })

      it('challengeMode "redirect" redirects a caller that would otherwise get a 401', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ challengeMode: 'redirect' }))
        const { ctx, redirect } = makeCtx({ headers: { accept: 'application/json' } })

        await handler.challenge(ctx)

        expect(redirect).toHaveBeenCalledOnce()
      })

      it('challengeMode "status" answers 401 even to a browser navigation', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ challengeMode: 'status' }))
        const { ctx, redirect, status } = makeCtx({ headers: { 'sec-fetch-mode': 'navigate' } })

        await handler.challenge(ctx)

        expect(redirect).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(401)
      })

      // The hook is the last word on the response, so it must run whichever branch the mode would have taken.
      it('onChallenge still wins over the mode', async () => {
        const onChallenge = vi.fn()
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onChallenge, challengeMode: 'status' }))
        const { ctx, redirect, status } = makeCtx({ headers: {} })

        await handler.challenge(ctx)

        expect(onChallenge).toHaveBeenCalledOnce()
        expect(redirect).not.toHaveBeenCalled()
        expect(status).not.toHaveBeenCalled()
      })
    })

    it('stores returnTo (current URL) in state cookie', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, cookie } = makeCtx({ url: '/dashboard?tab=settings' })
      await handler.challenge(ctx)

      const [, stateCookieJWT] = cookie.mock.calls[0] as [string, string]
      const { decodeState } = await import('../internal/remote/state_store.js')
      const stored = await decodeState(stateCookieJWT, SESSION_SECRET, SCHEME)
      expect(stored.returnTo).toBe('/dashboard?tab=settings')
    })
  })

  describe('secure cookie resolution', () => {
    // Constructs the handler directly from a raw options object, bypassing the builder —
    // the path where a fail-open default would actually bite.
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(DISCOVERY_DOCUMENT),
        }),
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function secureFlagFor(options: OIDCAuthenticationOptions) {
      const handler = new OIDCAuthenticationHandler('OIDC', options)
      const { ctx, cookie } = makeCtx()
      await handler.challenge(ctx)

      const [, , opts] = cookie.mock.calls[0] as [string, string, Record<string, unknown>]
      return opts.secure
    }

    function withoutSecureCookie(callbackURL: string): OIDCAuthenticationOptions {
      const opts = makeBaseOptions({ callbackURL })
      delete opts.secureCookie
      return opts
    }

    it('defaults to secure when secureCookie is omitted and callbackURL is https', async () => {
      expect(await secureFlagFor(withoutSecureCookie('https://app.example.com/cb'))).toBe(true)
    })

    it('defaults to non-secure when secureCookie is omitted and callbackURL is http', async () => {
      expect(await secureFlagFor(withoutSecureCookie('http://localhost:3000/cb'))).toBe(false)
    })

    it('honours an explicit secureCookie override on an http callback', async () => {
      const opts = makeBaseOptions({ callbackURL: 'http://localhost:3000/cb', secureCookie: true })
      expect(await secureFlagFor(opts)).toBe(true)
    })
  })

  describe('revoke()', () => {
    it('clears the session cookie so the user is signed out', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
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
      const jwt = await encodeSession(session, SESSION_SECRET, SCHEME, 3600)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ roleClaimType: 'groups' }))
      const { ctx } = makeCtx({ cookies: { __oidc_session: jwt } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.isInRole('admin')).toBe(true)
    })
  })

  describe('forbid()', () => {
    it('sets 403 by default', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
      const { ctx, status } = makeCtx()

      await handler.forbid(ctx)
      expect(status).toHaveBeenCalledWith(403)
    })

    it('delegates to onForbid when provided', async () => {
      const onForbid = vi.fn()
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ onForbid }))
      const { ctx, status } = makeCtx()

      await handler.forbid(ctx)

      expect(onForbid).toHaveBeenCalledOnce()
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('processCallback()', () => {
    let privateKey: CryptoKey
    let jwksResolver: (uri: string) => JWTVerifyGetKey

    beforeEach(async () => {
      const pair = await generateKeyPair('RS256')
      privateKey = pair.privateKey
      const jwk = await exportJWK(pair.publicKey)
      const localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] })
      jwksResolver = () => localJwks as JWTVerifyGetKey
    })

    async function signIDToken(nonce: string, extraClaims: Record<string, unknown> = {}) {
      return new SignJWT({ sub: 'user123', email: 'user@example.com', nonce, ...extraClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey)
    }

    function mockFetch(
      nonce: string,
      extraClaims: Record<string, unknown> = {},
      discovery: Record<string, unknown> = {},
    ) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, ...discovery }) }
          }
          if (opts?.method === 'POST') {
            const idToken = await signIDToken(nonce, extraClaims)
            return {
              ok: true,
              json: () => Promise.resolve({ id_token: idToken, access_token: 'at', token_type: 'Bearer' }),
            }
          }
          return { ok: false, status: 404 }
        }),
      )
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function makeStateCookie(nonce: string, state = 'st') {
      return encodeState(
        {
          state,
          nonce,
          codeVerifier: 'cv',
          pkceMethod: 'S256',
          returnTo: '/dashboard',
          scheme: SCHEME,
          issuer: ISSUER,
        },
        SESSION_SECRET,
        SCHEME,
      )
    }

    describe('authorization error response', () => {
      it('reports the provider error rather than a missing code', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          url: CALLBACK_PATH,
          query: { error: 'access_denied', error_description: 'User denied consent' },
        })

        const promise = handler.processCallback(ctx)
        await expect(promise).rejects.toThrow('provider returned "access_denied"')
        // The old behaviour misdiagnosed this as a missing code.
        await expect(promise).rejects.not.toThrow('missing code parameter')
      })

      // error_description is provider-authored free text: it can name the user or say why
      // they were refused, so it is redacted on the same terms as the token-endpoint one.
      it('redacts the provider description by default', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          url: CALLBACK_PATH,
          query: { error: 'access_denied', error_description: 'jane.doe@example.com denied consent' },
        })

        const promise = handler.processCallback(ctx)
        await expect(promise).rejects.not.toThrow('jane.doe@example.com')
        await expect(promise).rejects.toThrow('is hidden')
      })

      it('reveals the provider description when showPii is on', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, showPii: true }))
        const { ctx } = makeCtx({
          url: CALLBACK_PATH,
          query: { error: 'access_denied', error_description: 'jane.doe@example.com denied consent' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('jane.doe@example.com denied consent')
      })

      it('keeps the description out of publicMessage either way', async () => {
        for (const showPii of [false, true]) {
          const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, showPii }))
          const { ctx } = makeCtx({
            url: CALLBACK_PATH,
            query: { error: 'access_denied', error_description: 'jane.doe@example.com denied consent' },
          })

          const error = (await handler.processCallback(ctx).catch((e: unknown) => e)) as { publicMessage: string }
          expect(error.publicMessage).toBe('Authentication failed')
          expect(error.publicMessage).not.toContain('jane.doe@example.com')
        }
      })

      it('reports an error with no description', async () => {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({ url: CALLBACK_PATH, query: { error: 'server_error' } })

        await expect(handler.processCallback(ctx)).rejects.toThrow('provider returned "server_error"')
      })
    })

    // Every other test here hands the handler its keys. A deployment hands it none: the keys are the ones the
    // provider publishes at `jwks_uri`, and that is the path a forged id_token has to get past.
    describe('with no key resolver of its own', () => {
      /** The provider, its key set included. `published` is what `jwks_uri` answers with. */
      function provider(nonce: string, signingKey: CryptoKey, published: CryptoKey): { jwksFetches: () => number } {
        let jwksFetches = 0

        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string | URL, opts?: RequestInit) => {
            // Asked first: the key set lives under `.well-known` too, where the discovery document is matched.
            if (String(url) === DISCOVERY_DOCUMENT.jwks_uri) {
              jwksFetches++
              const jwk = await exportJWK(published)
              return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            }
            if (String(url).includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await new SignJWT({ sub: 'user123', nonce })
                .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
                .setIssuer(ISSUER)
                .setAudience(CLIENT_ID)
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(signingKey)
              return {
                ok: true,
                json: () => Promise.resolve({ id_token: idToken, access_token: 'at', token_type: 'Bearer' }),
              }
            }
            return { ok: false, status: 404 }
          }),
        )

        return { jwksFetches: () => jwksFetches }
      }

      async function callback(nonce: string) {
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions())
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie(nonce) },
          query: { code: 'c', state: 'st' },
        })

        return handler.processCallback(ctx)
      }

      it('accepts an id_token signed with a key the provider publishes at jwks_uri', async () => {
        const pair = await generateKeyPair('RS256')
        const { jwksFetches } = provider('published-key', pair.privateKey, pair.publicKey)

        await expect(callback('published-key')).resolves.toBeUndefined()
        expect(jwksFetches()).toBe(1)
      })

      it('refuses an id_token signed with a key the provider does not publish', async () => {
        const providers = await generateKeyPair('RS256')
        const forgers = await generateKeyPair('RS256')
        provider('forged', forgers.privateKey, providers.publicKey)

        await expect(callback('forged')).rejects.toThrow(/signature verification failed/)
      })
    })

    describe('RFC 9207 iss validation', () => {
      it('rejects an iss that is not the provider issuer', async () => {
        const nonce = 'iss-nonce'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st', iss: 'https://attacker.example.com' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('iss does not match')
      })

      it('accepts a matching iss', async () => {
        const nonce = 'iss-ok'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st', iss: ISSUER },
        })

        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })

      it('accepts an absent iss from a provider that does not advertise the parameter', async () => {
        const nonce = 'iss-absent'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        // Requiring it unconditionally would break every provider that has not implemented
        // RFC 9207, which is why the requirement is gated on the discovery metadata.
        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })

      // T-MULTI-03. Where the provider says it sends `iss`, a response without one is either
      // a misbehaving provider or an attacker who stripped it — accepting it optionally there
      // would let the mix-up defence be switched off by the attacker it defends against.
      it('rejects an absent iss when the provider advertises the parameter', async () => {
        const nonce = 'iss-required'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce, {}, { authorization_response_iss_parameter_supported: true })

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('missing iss parameter')
      })

      it('accepts a matching iss when the provider advertises the parameter', async () => {
        const nonce = 'iss-required-ok'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce, {}, { authorization_response_iss_parameter_supported: true })

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st', iss: ISSUER },
        })

        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })

      it('rejects a wrong iss whether or not the provider advertises the parameter', async () => {
        for (const advertised of [undefined, true]) {
          const nonce = `iss-wrong-${String(advertised)}`
          const stateCookieJWT = await makeStateCookie(nonce)
          mockFetch(
            nonce,
            {},
            advertised === undefined ? {} : { authorization_response_iss_parameter_supported: advertised },
          )

          const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
          const { ctx } = makeCtx({
            cookies: { '__oidc_state.st': stateCookieJWT },
            query: { code: 'c', state: 'st', iss: 'https://attacker.example.com' },
          })

          await expect(handler.processCallback(ctx)).rejects.toThrow('iss does not match')
        }
      })
    })

    describe('discovery cache', () => {
      function countingFetch(nonce: string) {
        const calls = { discovery: 0 }
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              calls.discovery++
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
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
        return calls
      }

      it('does not refetch within the ttl', async () => {
        const calls = countingFetch('n')
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))

        await handler.challenge(makeCtx().ctx)
        await handler.challenge(makeCtx().ctx)

        expect(calls.discovery).toBe(1)
      })

      /**
       * The memo alone is not enough: it is only populated after the fetch resolves, so
       * callers that arrive while one is in flight all miss it. That is the normal case, not
       * an edge one — a single `challenge()` resolves the issuer, the authorization endpoint
       * and the PKCE method concurrently, and every request arriving after the TTL expires
       * enters together. Without single-flight, a busy handler stampedes the provider on
       * every refresh.
       */
      it('fetches discovery once when challenges overlap', async () => {
        const calls = countingFetch('n')
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))

        // Started without awaiting between them, so neither can observe the other's memo.
        await Promise.all([
          handler.challenge(makeCtx().ctx),
          handler.challenge(makeCtx().ctx),
          handler.challenge(makeCtx().ctx),
        ])

        expect(calls.discovery).toBe(1)
      })

      // Providers rotate endpoints and withdraw capabilities; a document cached for the
      // process lifetime means a handler can keep using terms the issuer has retired.
      it('refetches once the ttl has elapsed', async () => {
        const calls = countingFetch('n')
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            discoveryCacheTtlSeconds: 0,
          }),
        )

        await handler.challenge(makeCtx().ctx)
        await handler.challenge(makeCtx().ctx)

        expect(calls.discovery).toBe(2)
      })

      it('refetches the JWKS when discovery rotates jwks_uri', async () => {
        let jwksURI = `${ISSUER}/.well-known/jwks.json`
        const seen: string[] = []

        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('openid-configuration')) {
              return { ok: true, json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, jwks_uri: jwksURI }) }
            }
            if (opts?.method === 'POST') {
              const idToken = await signIDToken('n')
              return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver: (uri: string) => {
              seen.push(uri)
              return jwksResolver(uri)
            },
            discoveryCacheTtlSeconds: 0,
          }),
        )

        const callback = async () => {
          const { ctx } = makeCtx({
            cookies: { '__oidc_state.st': await makeStateCookie('n') },
            query: { code: 'c', state: 'st' },
          })
          await handler.processCallback(ctx)
        }

        // The first exchange resolves the JWKS, so the resolver is already memoised before
        // the rotation — without that ordering the assertion below proves nothing.
        await callback()
        expect(seen).toEqual([`${ISSUER}/.well-known/jwks.json`])

        // A resolver memoised for the process lifetime keeps fetching keys from an endpoint
        // the issuer has retired, and every id_token then fails to verify.
        jwksURI = `${ISSUER}/.well-known/jwks-2.json`
        await callback()

        expect(seen).toEqual([`${ISSUER}/.well-known/jwks.json`, `${ISSUER}/.well-known/jwks-2.json`])
      })

      // The converse of the rotation test: when jwks_uri is unchanged across a refresh, the
      // resolver must survive. Discarding it every hour forces a cold JWKS fetch onto the first
      // user-facing callback after each TTL rollover, for keys createRemoteJWKSet already caches.
      it('keeps the JWKS resolver when jwks_uri is unchanged across a refresh', async () => {
        const seen: string[] = []
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('openid-configuration')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await signIDToken('n')
              return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver: (uri: string) => {
              seen.push(uri)
              return jwksResolver(uri)
            },
            discoveryCacheTtlSeconds: 0,
          }),
        )

        const callback = async () => {
          const { ctx } = makeCtx({
            cookies: { '__oidc_state.st': await makeStateCookie('n') },
            query: { code: 'c', state: 'st' },
          })
          await handler.processCallback(ctx)
        }

        await callback()
        await callback()

        // Discovery refetched both times (TTL 0), but the resolver was built once.
        expect(seen).toEqual([`${ISSUER}/.well-known/jwks.json`])
      })

      /**
       * A provider that advertises no usable PKCE method makes selectPKCEMethod throw. The
       * document must not be cached as fresh in that state: if it were, the first challenge
       * would fail correctly and every later one would find the cache fresh, skip re-derivation,
       * and send a PKCE-less request with code_challenge_method=undefined.
       */
      it('does not cache a document whose PKCE derivation throws', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            ok: true,
            // plain only, and allowPlainPKCE defaults off -> selectPKCEMethod throws.
            json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, code_challenge_methods_supported: ['plain'] }),
          })),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))

        await expect(handler.challenge(makeCtx().ctx)).rejects.toThrow(/PKCE/)
        // The poisoned-cache bug made this second call resolve with pkceMethod undefined.
        await expect(handler.challenge(makeCtx().ctx)).rejects.toThrow(/PKCE/)
      })

      it('re-validates the issuer on every refetch', async () => {
        let issuer = ISSUER
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, issuer }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            discoveryCacheTtlSeconds: 0,
          }),
        )
        await expect(handler.challenge(makeCtx().ctx)).resolves.toBeUndefined()

        // A document swapped under us must not silently redefine the issuer that every
        // id_token is then validated against.
        issuer = 'https://attacker.example.com'
        await expect(handler.challenge(makeCtx().ctx)).rejects.toThrow('does not match the configured issuer')
      })

      // A provider whose discovery endpoint is down for a minute is otherwise a sign-in outage here, although
      // everything needed to sign a user in is already in hand.
      describe('when the provider cannot be asked again', () => {
        function providerThatGoesDown(failure: () => unknown) {
          const provider = { down: false, asked: 0 }

          vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
              if (typeof url === 'string' && url.includes('.well-known')) {
                provider.asked++
                if (provider.down) {
                  return failure()
                }
                return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
              }
              return { ok: false, status: 404 }
            }),
          )

          return provider
        }

        const outages: Array<[string, () => unknown]> = [
          ['is unreachable', () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:443'))],
          ['answers with an error status', () => ({ ok: false, status: 503 })],
          [
            'answers with a page that is not JSON',
            () => ({ ok: true, json: () => Promise.reject(new Error('<html>')) }),
          ],
        ]

        it.each(outages)('goes on with the document in hand when the provider %s', async (_, failure) => {
          const provider = providerThatGoesDown(failure)
          const handler = new OIDCAuthenticationHandler(
            'OIDC',
            makeBaseOptions({ jwksResolver, discoveryCacheTtlSeconds: 0 }),
          )

          await handler.challenge(makeCtx().ctx)
          provider.down = true

          const { ctx, redirect } = makeCtx()
          await expect(handler.challenge(ctx)).resolves.toBeUndefined()
          expect((redirect.mock.calls[0] as [string])[0]).toContain(`${ISSUER}/auth`)
        })

        it('has nothing to go on with when the very first fetch fails', async () => {
          const provider = providerThatGoesDown(() => ({ ok: false, status: 503 }))
          provider.down = true

          const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))

          await expect(handler.challenge(makeCtx().ctx)).rejects.toMatchObject({
            code: 'ERR_OIDC_DISCOVERY',
            unreachable: true,
          })
        })

        // Every request would otherwise wait out the timeout of a provider that is not answering.
        it('leaves a provider that is down alone for a while before asking again', async () => {
          vi.useFakeTimers({ toFake: ['Date'] })

          try {
            const provider = providerThatGoesDown(() => ({ ok: false, status: 503 }))
            const handler = new OIDCAuthenticationHandler(
              'OIDC',
              makeBaseOptions({ jwksResolver, discoveryCacheTtlSeconds: 0 }),
            )

            await handler.challenge(makeCtx().ctx)
            provider.down = true

            await handler.challenge(makeCtx().ctx)
            await handler.challenge(makeCtx().ctx)
            await handler.challenge(makeCtx().ctx)
            expect(provider.asked).toBe(2)

            vi.setSystemTime(Date.now() + 31_000)
            await handler.challenge(makeCtx().ctx)
            expect(provider.asked).toBe(3)

            provider.down = false
            vi.setSystemTime(Date.now() + 31_000)
            await handler.challenge(makeCtx().ctx)
            expect(provider.asked).toBe(4)
          } finally {
            vi.useRealTimers()
          }
        })

        // A document that arrived and was refused is the provider saying something new, not saying nothing.
        it('does not ride out a document that was fetched and refused', async () => {
          let pkce = ['S256']
          vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
              ok: true,
              json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, code_challenge_methods_supported: pkce }),
            })),
          )

          const handler = new OIDCAuthenticationHandler(
            'OIDC',
            makeBaseOptions({ jwksResolver, discoveryCacheTtlSeconds: 0 }),
          )
          await handler.challenge(makeCtx().ctx)

          pkce = ['plain']
          await expect(handler.challenge(makeCtx().ctx)).rejects.toThrow(/PKCE/)
        })
      })
    })

    /**
     * These two guards were present but undefended: removing either left the whole suite
     * green. Both are cheap to lose in a refactor and expensive to lose in production.
     */
    describe('id_token trust boundary', () => {
      async function callbackWithToken(idToken: string, nonce: string, resolver?: JWTVerifyGetKey) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver: resolver ? () => resolver : jwksResolver,
          }),
        )
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie(nonce) },
          query: { code: 'c', state: 'st' },
        })
        return handler.processCallback(ctx)
      }

      // OIDC Core §3.1.3.7 step 3. The same provider issues tokens to every client it serves;
      // without this, a token minted for a different application at the same IdP is accepted
      // here, and its subject becomes a user of this one.
      it('rejects an id_token issued for another client', async () => {
        const nonce = 'aud-test'
        const foreign = await new SignJWT({ sub: 'user123', nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(ISSUER)
          .setAudience('a-different-client')
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey)

        await expect(callbackWithToken(foreign, nonce)).rejects.toThrow('id_token validation failed')
      })

      /**
       * An id_token is trusted because the provider's private key signed it. A symmetric
       * algorithm moves that trust to a shared secret — and the classic attack substitutes
       * HS256 signed with the provider's *public* key, which is not secret at all.
       */
      it('rejects an id_token signed with a symmetric algorithm', async () => {
        const nonce = 'hs256-test'
        const secret = new TextEncoder().encode('shared-secret-at-least-32-bytes-long!!')
        const symmetric = await new SignJWT({ sub: 'user123', nonce })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(secret)

        // The resolver hands back the very key the token was signed with, so the signature
        // itself verifies: only the algorithm restriction stands between this and a session.
        const resolver = (async () => secret) as unknown as JWTVerifyGetKey

        await expect(callbackWithToken(symmetric, nonce, resolver)).rejects.toThrow('id_token validation failed')
      })

      // OIDC Core §2 requires both. A time claim is only checked when there is one, so a token without `exp` is
      // otherwise good forever.
      it('rejects an id_token that never expires', async () => {
        const nonce = 'no-exp'
        const eternal = await new SignJWT({ sub: 'user123', nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .sign(privateKey)

        await expect(callbackWithToken(eternal, nonce)).rejects.toThrow(/id_token validation failed.*"exp"/)
      })

      it('rejects an id_token that does not say when it was issued', async () => {
        const nonce = 'no-iat'
        const undated = await new SignJWT({ sub: 'user123', nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setExpirationTime('1h')
          .sign(privateKey)

        await expect(callbackWithToken(undated, nonce)).rejects.toThrow(/id_token validation failed.*"iat"/)
      })
    })

    // OIDC Core §3.1.3.3. The access token goes on to be presented at the UserInfo endpoint as a bearer token,
    // which is not how a token of another type was issued to be used.
    describe('token_type', () => {
      async function callbackWithTokenType(tokenType: string | undefined) {
        const nonce = 'token-type'
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              return {
                ok: true,
                json: async () => ({
                  id_token: await signIDToken(nonce),
                  access_token: 'at',
                  ...(tokenType === undefined ? {} : { token_type: tokenType }),
                }),
              }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie(nonce) },
          query: { code: 'c', state: 'st' },
        })
        return handler.processCallback(ctx)
      }

      it.each(['Bearer', 'bearer', 'BEARER'])('accepts %s, compared without regard to case', async tokenType => {
        await expect(callbackWithTokenType(tokenType)).resolves.toBeUndefined()
      })

      it.each(['mac', 'DPoP', 'bearer-ish'])('refuses an access token of type %s', async tokenType => {
        await expect(callbackWithTokenType(tokenType)).rejects.toThrow(`an access token of type "${tokenType}"`)
      })

      // RFC 6749 §5.1 requires it, so a response without one is not something to guess about.
      it('refuses an access token that comes without a type', async () => {
        await expect(callbackWithTokenType(undefined)).rejects.toThrow('an access token without a token_type')
      })
    })

    describe('authorization parameters', () => {
      async function challengeURL(overrides: Record<string, unknown>) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            ok: true,
            json: () => Promise.resolve(DISCOVERY_DOCUMENT),
          })),
        )
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, ...overrides }))
        const { ctx, redirect } = makeCtx()
        await handler.challenge(ctx)
        return new URL(redirect.mock.calls[0][0] as string)
      }

      it('sends the configured parameters', async () => {
        const url = await challengeURL({
          prompt: 'login',
          loginHint: 'jane@example.com',
          acrValues: ['urn:mace:incommon:iap:silver', 'phr'],
          maxAgeSeconds: 300,
        })

        expect(url.searchParams.get('prompt')).toBe('login')
        expect(url.searchParams.get('login_hint')).toBe('jane@example.com')
        expect(url.searchParams.get('acr_values')).toBe('urn:mace:incommon:iap:silver phr')
        expect(url.searchParams.get('max_age')).toBe('300')
      })

      it('sends none of them by default', async () => {
        const url = await challengeURL({})
        for (const key of ['prompt', 'login_hint', 'acr_values', 'max_age']) {
          expect(url.searchParams.get(key)).toBeNull()
        }
      })

      it('carries provider-specific extras', async () => {
        const url = await challengeURL({ extraAuthorizationParams: { audience: 'https://api.example.com' } })
        expect(url.searchParams.get('audience')).toBe('https://api.example.com')
      })

      // Extras are applied before the protocol parameters precisely so this cannot happen.
      it('does not let an extra displace a protocol parameter', async () => {
        const url = await challengeURL({
          extraAuthorizationParams: { redirect_uri: 'https://evil.example.com/cb', nonce: 'attacker-nonce' },
        })

        expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
        expect(url.searchParams.get('nonce')).not.toBe('attacker-nonce')
      })

      it('lets the redirect hook add and adjust non-guarded parameters', async () => {
        const url = await challengeURL({
          prompt: 'login',
          onRedirectToProvider: (_ctx: unknown, u: URL) => {
            u.searchParams.set('prompt', 'consent')
            u.searchParams.set('ui_locales', 'pt-BR')
          },
        })

        expect(url.searchParams.get('prompt')).toBe('consent')
        expect(url.searchParams.get('ui_locales')).toBe('pt-BR')
      })

      /**
       * A hook is application code and application code makes mistakes. A stray delete while
       * stripping something else would turn PKCE off for every sign-in, and nothing about the
       * flow would look broken.
       */
      it('does not let the redirect hook strip PKCE', async () => {
        const url = await challengeURL({
          onRedirectToProvider: (_ctx: unknown, u: URL) => {
            u.searchParams.delete('code_challenge')
            u.searchParams.delete('code_challenge_method')
          },
        })

        expect(url.searchParams.get('code_challenge')).toBeTruthy()
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      })

      it('does not let the redirect hook change where the code is sent', async () => {
        const url = await challengeURL({
          onRedirectToProvider: (_ctx: unknown, u: URL) => {
            u.searchParams.set('redirect_uri', 'https://evil.example.com/cb')
            u.searchParams.set('client_id', 'other-client')
            u.searchParams.set('state', 'attacker-state')
            u.searchParams.set('nonce', 'attacker-nonce')
          },
        })

        expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
        expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
        expect(url.searchParams.get('state')).not.toBe('attacker-state')
        expect(url.searchParams.get('nonce')).not.toBe('attacker-nonce')
      })

      /**
       * The guarded-parameter restore protected parameter *values* but not the endpoint: a hook
       * holding the live URL could rewrite the host and the guarded params were faithfully
       * re-applied onto it. The hook now receives a throwaway copy, so the origin it is sent to
       * is unreachable from application code.
       */
      it('does not let the redirect hook move the request off-origin', async () => {
        const url = await challengeURL({
          onRedirectToProvider: (_ctx: unknown, u: URL) => {
            u.host = 'evil.example.com'
            u.protocol = 'http:'
            u.pathname = '/steal'
          },
        })

        expect(url.origin).toBe(new URL(DISCOVERY_DOCUMENT.authorization_endpoint).origin)
        expect(url.protocol).toBe('https:')
        expect(url.pathname).toBe(new URL(DISCOVERY_DOCUMENT.authorization_endpoint).pathname)
        // The guarded params are still present and correct on the real endpoint.
        expect(url.searchParams.get('code_challenge')).toBeTruthy()
        expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
      })
    })

    describe('max_age and auth_time (OIDC Core §2)', () => {
      async function callbackWith(extraClaims: Record<string, unknown>, options: Record<string, unknown> = {}) {
        const nonce = 'age'
        mockFetch(nonce, extraClaims)
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            maxAgeSeconds: 300,
            ...options,
          }),
        )
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie(nonce) },
          query: { code: 'c', state: 'st' },
        })
        return handler.processCallback(ctx)
      }

      const now = () => Math.floor(Date.now() / 1000)

      it('accepts a recent auth_time', async () => {
        await expect(callbackWith({ auth_time: now() - 10 })).resolves.toBeUndefined()
      })

      // A provider that ignores max_age would otherwise pass silently, leaving a freshness
      // control that reads as enforced and is not.
      it('rejects an id_token with no auth_time when max_age was requested', async () => {
        await expect(callbackWith({})).rejects.toThrow('no auth_time claim')
      })

      it('rejects an authentication older than max_age', async () => {
        await expect(callbackWith({ auth_time: now() - 900 })).rejects.toThrow('older than the requested max_age')
      })

      it('allows clock drift within the configured tolerance', async () => {
        await expect(callbackWith({ auth_time: now() - 330 }, { clockToleranceSeconds: 60 })).resolves.toBeUndefined()
      })

      it('does not require auth_time when max_age was not requested', async () => {
        await expect(callbackWith({}, { maxAgeSeconds: undefined })).resolves.toBeUndefined()
      })
    })

    describe('UserInfo endpoint (OIDC Core §5.3)', () => {
      const USERINFO = `${ISSUER}/userinfo`

      function mockWithUserInfo(nonce: string, userInfo: unknown, status = 200) {
        const seen: string[] = []
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return {
                ok: true,
                json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, userinfo_endpoint: USERINFO }),
              }
            }
            if (url === USERINFO) {
              seen.push((opts?.headers as Record<string, string>)?.Authorization ?? '')
              return { ok: status < 400, status, json: () => Promise.resolve(userInfo) }
            }
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
        return seen
      }

      async function runCallback(handler: OIDCAuthenticationHandler, nonce: string) {
        const { ctx, cookie } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie(nonce) },
          query: { code: 'c', state: 'st' },
        })
        await handler.processCallback(ctx)
        const jwt = cookie.mock.calls.find(c => c[0] === '__oidc_session')![1] as string
        return decodeSession(jwt, SESSION_SECRET, SCHEME)
      }

      it('does not call the endpoint unless asked', async () => {
        const seen = mockWithUserInfo('n', { sub: 'user123' })
        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))

        await runCallback(handler, 'n')

        expect(seen).toEqual([])
      })

      it('merges user info claims with the access token', async () => {
        const seen = mockWithUserInfo('n', { sub: 'user123', name: 'Jane Doe', groups: ['admin'] })
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            getClaimsFromUserInfoEndpoint: true,
          }),
        )

        const session = await runCallback(handler, 'n')

        expect(seen).toEqual(['Bearer at'])
        expect(session.claims.find(c => c.type === 'name')?.value).toBe('Jane Doe')
        // From the id_token, still present alongside the merged fields.
        expect(session.claims.find(c => c.type === 'email')?.value).toBe('user@example.com')
      })

      /**
       * The id_token is signed and verified against the JWKS; the UserInfo body is ordinary
       * JSON authenticated only by the bearer token. Letting the weaker source overwrite the
       * stronger one is the whole reason the merge is ordered rather than a plain spread.
       */
      it('does not let user info overwrite an id_token claim', async () => {
        mockWithUserInfo('n', { sub: 'user123', email: 'attacker@evil.example.com' })
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            getClaimsFromUserInfoEndpoint: true,
          }),
        )

        const session = await runCallback(handler, 'n')

        expect(session.claims.find(c => c.type === 'email')?.value).toBe('user@example.com')
      })

      // §5.3.2: a response whose sub differs describes a different user than the one who just
      // authenticated — exactly the confusion that attaches one account's claims to another's
      // session. The spec says MUST NOT be used; using nothing at all is the safe reading.
      it('rejects a user info response whose sub does not match the id_token', async () => {
        mockWithUserInfo('n', { sub: 'someone-else', name: 'Mallory' })
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            getClaimsFromUserInfoEndpoint: true,
          }),
        )
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie('n') },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('sub does not match')
      })

      it('does not leak either sub when showPii is off', async () => {
        mockWithUserInfo('n', { sub: 'someone-else' })
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            getClaimsFromUserInfoEndpoint: true,
          }),
        )
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie('n') },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow(/is hidden/)
        await expect(handler.processCallback(ctx)).rejects.not.toThrow(/someone-else/)
      })

      it('reports a provider that advertises no userinfo_endpoint', async () => {
        mockFetch('n')
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            getClaimsFromUserInfoEndpoint: true,
          }),
        )
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie('n') },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('advertises no userinfo_endpoint')
      })

      it('fails the sign-in when the endpoint errors', async () => {
        mockWithUserInfo('n', {}, 503)
        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            getClaimsFromUserInfoEndpoint: true,
          }),
        )
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': await makeStateCookie('n') },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('user info endpoint returned 503')
      })
    })

    describe('claim hygiene', () => {
      it('applies removeClaims even when a claimMapper is set', async () => {
        const nonce = 'mapper-remove'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            claimMapper: () => [new Claim('sub', 'u1', ISSUER), new Claim('birthdate', '1985-07-04', ISSUER)],
            claimActions: { remove: ['birthdate'] },
          }),
        )
        const { ctx, cookie } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)

        const jwt = cookie.mock.calls.find(c => c[0] === '__oidc_session')![1] as string
        const session = await decodeSession(jwt, SESSION_SECRET, SCHEME)
        expect(session.claims.map(c => c.type)).toEqual(['sub'])
      })

      // claimMapper is documented as the full override, so a mapper that deliberately emits a
      // registered claim keeps it. Only the caller's explicit remove list is applied on top.
      it('leaves registered claims a custom mapper deliberately emits', async () => {
        const nonce = 'mapper-registered'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce)

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            claimMapper: () => [new Claim('sub', 'u1', ISSUER), new Claim('sid', 'session-1', ISSUER)],
          }),
        )
        const { ctx, cookie } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)

        const jwt = cookie.mock.calls.find(c => c[0] === '__oidc_session')![1] as string
        const session = await decodeSession(jwt, SESSION_SECRET, SCHEME)
        expect(session.claims.map(c => c.type)).toEqual(['sub', 'sid'])
      })
    })

    describe('state binding', () => {
      it('rejects state minted for another strategy', async () => {
        const nonce = 'other-scheme'
        mockFetch(nonce)
        // Sealed under this handler's key so it decrypts, but naming another strategy: the
        // payload binding is what rejects it.
        const stateCookieJWT = await encodeState(
          {
            state: 'st',
            nonce,
            codeVerifier: 'cv',
            pkceMethod: 'S256',
            returnTo: '/dashboard',
            scheme: 'SomeOtherStrategy',
            issuer: ISSUER,
          },
          SESSION_SECRET,
          SCHEME,
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('issued for another strategy')
      })

      it('rejects state minted against a different issuer', async () => {
        const nonce = 'other-issuer'
        mockFetch(nonce)
        const stateCookieJWT = await encodeState(
          {
            state: 'st',
            nonce,
            codeVerifier: 'cv',
            pkceMethod: 'S256',
            returnTo: '/dashboard',
            scheme: SCHEME,
            issuer: 'https://old-provider.example.com',
          },
          SESSION_SECRET,
          SCHEME,
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('different issuer')
      })
    })

    it('sets session cookie and redirects on successful callback', async () => {
      const nonce = 'test-nonce'
      const stateCookieJWT = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx, cookie, redirect } = makeCtx({
        url: CALLBACK_PATH + '?code=auth-code&state=st',
        cookies: { '__oidc_state.st': stateCookieJWT },
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
      const stateCookieJWT = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx, deleteCookie } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'code', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(deleteCookie).toHaveBeenCalledWith('__oidc_state.st', expect.any(Object))
    })

    // A failed callback used to leave a live state cookie for the rest of its 600s TTL, so the flow it
    // belonged to stayed replayable after it had already been rejected.
    it('clears the state cookie even when the callback fails', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const stateCookieJWT = await encodeState(
        {
          state: 'st',
          nonce: 'n',
          codeVerifier: 'cv',
          pkceMethod: 'S256',
          returnTo: '/',
          scheme: SCHEME,
          issuer: 'https://other.example',
        },
        SESSION_SECRET,
        SCHEME,
      )
      const { ctx, deleteCookie } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow()
      expect(deleteCookie).toHaveBeenCalledWith('__oidc_state.st', expect.any(Object))
    })

    it('throws when code query param is missing', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({ url: CALLBACK_PATH, query: { state: 'st' } })
      await expect(handler.processCallback(ctx)).rejects.toThrow('missing code parameter')
    })

    it('throws when state cookie is missing', async () => {
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({ url: CALLBACK_PATH, query: { code: 'c', state: 'st' } })
      await expect(handler.processCallback(ctx)).rejects.toThrow('missing state cookie')
    })

    it('throws when state param does not match stored state', async () => {
      const stateCookieJWT = await encodeState(
        {
          state: 'correct',
          nonce: 'n',
          codeVerifier: 'cv',
          pkceMethod: 'S256',
          returnTo: '/',
          scheme: SCHEME,
          issuer: ISSUER,
        },
        SESSION_SECRET,
        SCHEME,
      )
      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        url: CALLBACK_PATH,
        // Planted under the name the *query* state derives, so the lookup succeeds and the sealed-vs-parameter
        // comparison is what rejects it — the per-flow cookie name would otherwise fail this earlier.
        cookies: { '__oidc_state.wrong': stateCookieJWT },
        query: { code: 'c', state: 'wrong' },
      })
      await expect(handler.processCallback(ctx)).rejects.toThrow('state mismatch')
    })

    it('throws when nonce in id_token does not match stored nonce', async () => {
      const stateCookieJWT = await makeStateCookie('correct-nonce')
      mockFetch('wrong-nonce')

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('nonce mismatch')
    })

    it('fires onFail when the callback fails, then rethrows', async () => {
      const onFail = vi.fn()
      const stateCookieJWT = await makeStateCookie('correct-nonce')
      mockFetch('wrong-nonce')

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onFail }))
      const { ctx } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
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
      const stateCookieJWT = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onFail }))
      const { ctx } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(onFail).not.toHaveBeenCalled()
    })

    describe('token exposure', () => {
      function mockFullTokenResponse(nonce: string, extra: Record<string, unknown> = {}) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await signIDToken(nonce)
              return {
                ok: true,
                json: () =>
                  Promise.resolve({
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
          }),
        )
      }

      it('hands the full token set to onTokenValidated', async () => {
        const onTokenValidated = vi.fn()
        const nonce = 'tokens-nonce'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFullTokenResponse(nonce)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onTokenValidated }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
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
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFullTokenResponse(nonce)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx, cookie } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)

        const [, sessionJWT] = cookie.mock.calls[0] as [string, string]
        // Refresh tokens are long-lived credentials and the cookie is client-side.
        expect(sessionJWT).not.toContain('the-refresh-token')
        expect(sessionJWT).not.toContain('the-access-token')

        const { decodeSession } = await import('../internal/remote/session_store.js')
        const session = await decodeSession(sessionJWT, SESSION_SECRET, SCHEME)
        expect(JSON.stringify(session)).not.toContain('the-refresh-token')
        expect(JSON.stringify(session)).not.toContain('the-access-token')
      })

      it('rejects an id_token whose at_hash does not bind the access token', async () => {
        const nonce = 'at-hash-bad'
        const stateCookieJWT = await makeStateCookie(nonce)
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await signIDToken(nonce, { at_hash: accessTokenHash('a-different-token', 'RS256') })
              return {
                ok: true,
                json: () =>
                  Promise.resolve({ id_token: idToken, access_token: 'the-access-token', token_type: 'Bearer' }),
              }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('at_hash does not match')
      })

      it('accepts an id_token whose at_hash binds the access token', async () => {
        const nonce = 'at-hash-ok'
        const stateCookieJWT = await makeStateCookie(nonce)
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await signIDToken(nonce, { at_hash: accessTokenHash('the-access-token', 'RS256') })
              return {
                ok: true,
                json: () =>
                  Promise.resolve({ id_token: idToken, access_token: 'the-access-token', token_type: 'Bearer' }),
              }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).resolves.toBeUndefined()
      })
    })

    describe('token endpoint client authentication', () => {
      async function exchangeWith(
        options: Partial<OIDCAuthenticationOptions>,
        discovery: Record<string, unknown> = DISCOVERY_DOCUMENT,
      ) {
        const nonce = 'auth-nonce'
        const stateCookieJWT = await makeStateCookie(nonce)
        const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(discovery) }
          }
          if (opts?.method === 'POST') {
            const idToken = await signIDToken(nonce)
            return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
          }
          return { ok: false, status: 404 }
        })
        vi.stubGlobal('fetch', fetchMock)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, ...options }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })
        await handler.processCallback(ctx)

        const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!
        const init = post[1] as RequestInit
        return {
          headers: init.headers as Record<string, string>,
          body: init.body as URLSearchParams,
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
        const secret = "s3cret:with+odd ~chars!'()"
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
        const { headers, body } = await exchangeWith(
          {},
          {
            ...DISCOVERY_DOCUMENT,
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          },
        )

        expect(headers.Authorization).toBeUndefined()
        expect(body.get('client_secret')).toBe('test-client-secret')
      })

      it('auto-selects basic when the provider advertises both', async () => {
        const { headers } = await exchangeWith(
          {},
          {
            ...DISCOVERY_DOCUMENT,
            token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          },
        )

        expect(headers.Authorization).toMatch(/^Basic /)
      })

      it('throws when the provider advertises neither basic nor post', async () => {
        await expect(
          exchangeWith(
            {},
            {
              ...DISCOVERY_DOCUMENT,
              token_endpoint_auth_methods_supported: ['private_key_jwt'],
            },
          ),
        ).rejects.toThrow('supports neither client_secret_basic nor client_secret_post')
      })
    })

    describe('showPii', () => {
      /** Awaits a rejection and hands back the error, failing loudly if it resolves. */
      async function captureError(promise: Promise<unknown>): Promise<Error & { publicMessage: string }> {
        try {
          await promise
        } catch (e) {
          return e as Error & { publicMessage: string }
        }
        throw new Error('expected the callback to reject')
      }

      async function nonceMismatch(showPii: boolean) {
        const stateCookieJWT = await makeStateCookie('the-real-nonce')
        mockFetch('the-wrong-nonce')

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, showPii }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        return captureError(handler.processCallback(ctx))
      }

      it('redacts claim values from diagnostics by default', async () => {
        const error = await nonceMismatch(false)

        expect(error.message).toContain('nonce mismatch')
        expect(error.message).toContain("[PII of type 'nonce' is hidden")
        expect(error.message).not.toContain('the-real-nonce')
        expect(error.message).not.toContain('the-wrong-nonce')
      })

      it('reveals claim values when enabled', async () => {
        const error = await nonceMismatch(true)

        expect(error.message).toContain('the-real-nonce')
        expect(error.message).toContain('the-wrong-nonce')
        expect(error.message).not.toContain('is hidden')
      })

      it('never leaks PII through publicMessage, whatever the setting', async () => {
        for (const showPii of [false, true]) {
          const error = await nonceMismatch(showPii)
          expect(error.publicMessage).toBe('Authentication failed')
          expect(error.publicMessage).not.toContain('nonce')
        }
      })

      it('redacts the claim listing when sub is missing', async () => {
        const stateCookieJWT = await makeStateCookie('sub-nonce')
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await new SignJWT({ email: 'jane@example.com', nonce: 'sub-nonce' })
                .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
                .setIssuer(ISSUER)
                .setAudience(CLIENT_ID)
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(privateKey)
              return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        const error = await captureError(handler.processCallback(ctx))
        expect(error.message).toContain('missing the sub claim')
        expect(error.message).toMatch(/\[\d+ claims hidden/)
        expect(error.message).not.toContain('email')
      })
    })

    describe('claimActions', () => {
      it('removes the named claims from the session', async () => {
        const nonce = 'actions-nonce'
        const stateCookieJWT = await makeStateCookie(nonce)
        mockFetch(nonce, { name: 'Jane Doe', picture: 'https://x/p.jpg', birthdate: '1985-07-04' })

        const handler = new OIDCAuthenticationHandler(
          'OIDC',
          makeBaseOptions({
            jwksResolver,
            claimActions: { remove: ['picture', 'birthdate'] },
          }),
        )
        const { ctx, cookie } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await handler.processCallback(ctx)

        const [, sessionJWT] = cookie.mock.calls[0] as [string, string]
        const { decodeSession } = await import('../internal/remote/session_store.js')
        const types = (await decodeSession(sessionJWT, SESSION_SECRET, SCHEME)).claims.map(c => c.type)

        expect(types).toContain('sub')
        expect(types).toContain('name')
        expect(types).not.toContain('picture')
        expect(types).not.toContain('birthdate')
      })
    })

    describe('id_token claim validation', () => {
      it('rejects an id_token without a sub claim', async () => {
        const nonce = 'no-sub'
        const stateCookieJWT = await makeStateCookie(nonce)
        // signIDToken always sets sub, so sign one explicitly without it.
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
            if (typeof url === 'string' && url.includes('.well-known')) {
              return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
            }
            if (opts?.method === 'POST') {
              const idToken = await new SignJWT({ email: 'u@x.com', nonce })
                .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
                .setIssuer(ISSUER)
                .setAudience(CLIENT_ID)
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(privateKey)
              return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })

        await expect(handler.processCallback(ctx)).rejects.toThrow('missing the sub claim')
      })

      async function callbackWithAudience(aud: string[], azp?: string) {
        const nonce = 'aud-nonce'
        const stateCookieJWT = await makeStateCookie(nonce)
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, opts?: RequestInit) => {
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
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(privateKey)
              return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
            }
            return { ok: false, status: 404 }
          }),
        )

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
          query: { code: 'c', state: 'st' },
        })
        return handler.processCallback(ctx)
      }

      it('rejects multiple audiences with no azp claim', async () => {
        await expect(callbackWithAudience([CLIENT_ID, 'other'])).rejects.toThrow('no azp claim')
      })

      it('rejects multiple audiences whose azp is another client', async () => {
        await expect(callbackWithAudience([CLIENT_ID, 'other'], 'other')).rejects.toThrow('azp does not match clientID')
      })

      it('accepts multiple audiences when azp matches this client', async () => {
        await expect(callbackWithAudience([CLIENT_ID, 'other'], CLIENT_ID)).resolves.toBeUndefined()
      })

      // OIDC Core §3.1.3.7 step 5: verified whenever it is present. The audience check alone passes a token the
      // provider says it issued to someone else.
      it('rejects a single audience whose azp is another client', async () => {
        await expect(callbackWithAudience([CLIENT_ID], 'other')).rejects.toThrow('azp does not match clientID')
      })

      it('accepts a single audience whose azp is this client', async () => {
        await expect(callbackWithAudience([CLIENT_ID], CLIENT_ID)).resolves.toBeUndefined()
      })
    })

    it('throws when the token endpoint returns a non-ok status with no error body', async () => {
      const nonce = 'bad-status'
      const stateCookieJWT = await makeStateCookie(nonce)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            return { ok: false, status: 503, json: () => Promise.reject(new Error('not json')) }
          }
          return { ok: false, status: 404 }
        }),
      )

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('token endpoint returned 503')
    })

    // The token-endpoint errors go through the callbackFailure seam, so they carry the strategy
    // name like every other callback failure — a bare ErrOIDCCallback would have dropped it.
    it('brands a token-endpoint failure with the strategy name', async () => {
      const stateCookieJWT = await makeStateCookie('n')
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            return { ok: false, status: 503, json: () => Promise.reject(new Error('not json')) }
          }
          return { ok: false, status: 404 }
        }),
      )

      const handler = new OIDCAuthenticationHandler('Okta', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        cookies: { [`${handler.stateCookieName}.st`]: stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('Cannot process callback for "Okta"')
    })

    // A literal `null` JSON body parses without throwing; the `?? {}` keeps the `.error` access
    // from becoming a TypeError, matching the OAuth2 handler.
    it('handles a null token-endpoint body without crashing', async () => {
      const stateCookieJWT = await makeStateCookie('n')
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            return { ok: false, status: 502, json: () => Promise.resolve(null) }
          }
          return { ok: false, status: 404 }
        }),
      )

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('token endpoint returned 502')
    })

    it('calls onTokenValidated hook with id_token payload', async () => {
      const onTokenValidated = vi.fn()
      const nonce = 'hook-nonce'
      const stateCookieJWT = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, onTokenValidated }))
      const { ctx } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
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
      const stateCookieJWT = await makeStateCookie(nonce)
      mockFetch(nonce, { groups: ['admin'] })

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
      const { ctx, cookie } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)

      const [, sessionJWT] = cookie.mock.calls[0] as [string, string]
      const { decodeSession } = await import('../internal/remote/session_store.js')
      const session = await decodeSession(sessionJWT, SESSION_SECRET, SCHEME)
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
        const stateCookieJWT = await encodeState(
          { state: 'st', nonce, codeVerifier: 'cv', pkceMethod: 'S256', returnTo, scheme: SCHEME, issuer: ISSUER },
          SESSION_SECRET,
          SCHEME,
        )
        mockFetch(nonce)

        const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver }))
        const { ctx, redirect } = makeCtx({
          cookies: { '__oidc_state.st': stateCookieJWT },
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
      const stateCookieJWT = await makeStateCookie(nonce)
      mockFetch(nonce)

      const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, claimMapper }))
      const { ctx, cookie } = makeCtx({
        cookies: { '__oidc_state.st': stateCookieJWT },
        query: { code: 'c', state: 'st' },
      })

      await handler.processCallback(ctx)
      expect(claimMapper).toHaveBeenCalledOnce()
      const [, sessionJWT] = cookie.mock.calls[0] as [string, string]
      const { decodeSession } = await import('../internal/remote/session_store.js')
      const session = await decodeSession(sessionJWT, SESSION_SECRET, SCHEME)
      expect(session.claims[0].type).toBe('mapped')
    })
  })
})
