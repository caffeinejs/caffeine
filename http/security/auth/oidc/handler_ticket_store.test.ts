import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import type { JWTVerifyGetKey, CryptoKey } from 'jose'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { claimsToSession, encodeSession, encodeTicketRef } from '../internal/remote/session_store.js'
import { encodeState } from '../internal/remote/state_store.js'
import type { RemoteAuthenticationTicket, RemoteAuthenticationTicketStore } from '../internal/remote/ticket_store.js'
import { OIDCAuthenticationHandler } from './handler.js'
import type { OIDCAuthenticationOptions } from './options.js'

/** The strategy name these handlers are registered under; cookies are sealed per scheme. */
const SCHEME = 'OIDC'

/**
 * These tests exercise the handler, not a store implementation, so they use the smallest
 * store that satisfies the contract. The shipped `TestOIDCTicketStore` lives in
 * `@caffeinejs/testing`, which depends on this package — importing it back would make the
 * dependency circular for no gain here.
 */
class FakeTicketStore implements RemoteAuthenticationTicketStore {
  readonly tickets = new Map<string, RemoteAuthenticationTicket>()

  async store(key: string, ticket: RemoteAuthenticationTicket): Promise<void> {
    this.tickets.set(key, ticket)
  }

  async retrieve(key: string): Promise<RemoteAuthenticationTicket | undefined> {
    return this.tickets.get(key)
  }

  async remove(key: string): Promise<void> {
    this.tickets.delete(key)
  }

  async removeBySubject(subject: string): Promise<void> {
    for (const [key, ticket] of this.tickets) {
      if (ticket.subject === subject) {
        this.tickets.delete(key)
      }
    }
  }
}

const SESSION_SECRET = 'test-session-secret-at-least-32-chars!!'
const CLIENT_ID = 'test-client-id'
const ISSUER = 'https://accounts.example.com'
const CALLBACK_URL = 'https://app.example.com/auth/callback'
const CALLBACK_PATH = '/auth/callback'
const SUBJECT = 'user123'
const EMAIL = 'jane.doe@example.com'

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
    scopes: ['openid', 'email'],
    secureCookie: false,
    ...overrides,
  }
}

function makeCtx(
  overrides: Partial<{
    url: string
    cookies: Record<string, string>
    query: Record<string, string>
  }> = {},
) {
  const cookies = overrides.cookies ?? {}
  const query = overrides.query ?? {}
  const cookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const redirect = vi.fn().mockReturnThis()
  const status = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()

  const ctx = {
    req: {
      url: overrides.url ?? '/dashboard',
      cookie: (name?: string) => (name === undefined ? cookies : cookies[name]),
      query: (key?: string) => (key === undefined ? query : query[key]),
      header: () => undefined,
    },
    cookie,
    deleteCookie,
    redirect,
    status,
    header,
  } as unknown as Context

  return { ctx, cookie, deleteCookie, redirect, status, header }
}

const DISCOVERY_DOCUMENT = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  code_challenge_methods_supported: ['S256'],
}

describe('OIDCAuthenticationHandler with a ticket store', () => {
  let privateKey: CryptoKey
  let jwksResolver: (uri: string) => JWTVerifyGetKey
  let store: FakeTicketStore

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    const jwk = await exportJWK(pair.publicKey)
    const localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] })
    jwksResolver = () => localJwks as JWTVerifyGetKey
    store = new FakeTicketStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFetch(nonce: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('.well-known')) {
          return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
        }
        if (opts?.method === 'POST') {
          const idToken = await new SignJWT({ sub: SUBJECT, email: EMAIL, nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(ISSUER)
            .setAudience(CLIENT_ID)
            .setExpirationTime('1h')
            .sign(privateKey)
          return { ok: true, json: () => Promise.resolve({ id_token: idToken, access_token: 'at' }) }
        }
        return { ok: false, status: 404 }
      }),
    )
  }

  /** Runs a full authorization callback and returns the session cookie value it set. */
  async function signIn(handler: OIDCAuthenticationHandler, existingSessionCookie?: string): Promise<string> {
    const nonce = 'test-nonce'
    mockFetch(nonce)
    const stateCookie = await encodeState(
      {
        state: 'st',
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

    const { ctx, cookie } = makeCtx({
      url: CALLBACK_PATH,
      cookies: {
        '__oidc_state.st': stateCookie,
        ...(existingSessionCookie ? { __oidc_session: existingSessionCookie } : {}),
      },
      query: { code: 'auth-code', state: 'st' },
    })

    await handler.processCallback(ctx)

    const call = cookie.mock.calls.find(c => c[0] === '__oidc_session')
    expect(call).toBeDefined()
    return call![1] as string
  }

  function handlerWith(store?: RemoteAuthenticationTicketStore) {
    return new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, ticketStore: store }))
  }

  describe('sign-in', () => {
    it('authenticates from a stored ticket', async () => {
      const handler = handlerWith(store)
      const sessionCookie = await signIn(handler)

      const { ctx } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe(SUBJECT)
      expect(result.ticket!.principal.findFirst('email')?.value).toBe(EMAIL)
    })

    it('persists exactly one ticket per sign-in', async () => {
      await signIn(handlerWith(store))
      expect(store.tickets.size).toBe(1)
    })

    // The claims never leave the server at all now — a strictly stronger statement than the
    // sealed cookie's, which merely keeps them unreadable.
    it('puts no claim value in the cookie, not even encrypted', async () => {
      const sessionCookie = await signIn(handlerWith(store))

      expect(sessionCookie).not.toContain(SUBJECT)
      expect(sessionCookie).not.toContain(EMAIL)
      // The cookie is an opaque key, so it is far shorter than one carrying the claims.
      const inline = await encodeSession(
        claimsToSession([new Claim('sub', SUBJECT, ISSUER), new Claim('email', EMAIL, ISSUER)], 'OIDC'),
        SESSION_SECRET,
        SCHEME,
        3600,
      )
      expect(sessionCookie.length).toBeLessThan(inline.length)
    })

    it('removes the previous ticket when signing in again', async () => {
      const handler = handlerWith(store)
      const first = await signIn(handler)
      expect(store.tickets.size).toBe(1)

      const second = await signIn(handler, first)

      // The old ticket would otherwise linger, revocable by nobody, until its ttl expired.
      expect(store.tickets.size).toBe(1)
      const { ctx } = makeCtx({ cookies: { __oidc_session: first } })
      expect((await handler.authenticate(ctx)).succeeded).toBe(false)

      const fresh = makeCtx({ cookies: { __oidc_session: second } })
      expect((await handler.authenticate(fresh.ctx)).succeeded).toBe(true)
    })
  })

  describe('revocation', () => {
    // The whole reason the store exists: a cookie that already authenticated must stop
    // working the moment the session behind it is revoked, without waiting for its ttl.
    it('rejects a previously valid cookie after removeBySubject', async () => {
      const handler = handlerWith(store)
      const sessionCookie = await signIn(handler)

      const before = await handler.authenticate(makeCtx({ cookies: { __oidc_session: sessionCookie } }).ctx)
      expect(before.succeeded).toBe(true)

      await store.removeBySubject(SUBJECT)

      const after = await handler.authenticate(makeCtx({ cookies: { __oidc_session: sessionCookie } }).ctx)
      expect(after.succeeded).toBe(false)
      expect(after.error).toBeInstanceOf(Error)
    })

    it('revoke() drops the stored ticket and clears the cookie', async () => {
      const handler = handlerWith(store)
      const sessionCookie = await signIn(handler)

      const { ctx, deleteCookie } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
      await handler.revoke(ctx)

      expect(store.tickets.size).toBe(0)
      expect(deleteCookie).toHaveBeenCalledWith('__oidc_session', expect.any(Object))

      const replay = makeCtx({ cookies: { __oidc_session: sessionCookie } })
      expect((await handler.authenticate(replay.ctx)).succeeded).toBe(false)
    })

    it('revoke() clears the cookie even when the store throws', async () => {
      const failing: RemoteAuthenticationTicketStore = {
        store: (k, t) => store.store(k, t),
        retrieve: k => store.retrieve(k),
        removeBySubject: s => store.removeBySubject(s),
        remove: () => Promise.reject(new Error('store is down')),
      }
      const handler = handlerWith(failing)
      const sessionCookie = await signIn(handler)

      const { ctx, deleteCookie } = makeCtx({ cookies: { __oidc_session: sessionCookie } })

      // The failure is surfaced — a sign-out that did not revoke must not report success —
      // but the browser's copy is cleared regardless.
      await expect(handler.revoke(ctx)).rejects.toThrow('store is down')
      expect(deleteCookie).toHaveBeenCalledWith('__oidc_session', expect.any(Object))
    })

    it('revoke() clears the cookie when there is no readable ticket reference', async () => {
      const handler = handlerWith(store)
      const { ctx, deleteCookie } = makeCtx({ cookies: { __oidc_session: 'not.a.token' } })

      await expect(handler.revoke(ctx)).resolves.toBeUndefined()
      expect(deleteCookie).toHaveBeenCalledWith('__oidc_session', expect.any(Object))
    })
  })

  describe('failure modes', () => {
    // An outage must never be the reason someone is let in.
    it('fails closed when the store throws on retrieve', async () => {
      const handler = handlerWith(store)
      const sessionCookie = await signIn(handler)

      const failing = handlerWith({
        store: (k, t) => store.store(k, t),
        retrieve: () => Promise.reject(new Error('store is down')),
        remove: k => store.remove(k),
        removeBySubject: s => store.removeBySubject(s),
      })

      const result = await failing.authenticate(makeCtx({ cookies: { __oidc_session: sessionCookie } }).ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    // A deployment's store serializer can return a shape-invalid ticket (a dropped empty claims
    // array, a partial row). That must fail closed like any other bad session, not throw a
    // TypeError out of authenticate() and 500 every request carrying the cookie.
    it('fails closed when the store returns a malformed session', async () => {
      const sessionCookie = await signIn(handlerWith(store))

      const malformed = handlerWith({
        store: (k, t) => store.store(k, t),
        // A ticket whose session lost its claims array.
        retrieve: async () => ({ session: { scheme: SCHEME } as never, subject: SUBJECT }),
        remove: k => store.remove(k),
        removeBySubject: s => store.removeBySubject(s),
      })

      const result = await malformed.authenticate(makeCtx({ cookies: { __oidc_session: sessionCookie } }).ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns none() when no cookie is presented', async () => {
      const result = await handlerWith(store).authenticate(makeCtx().ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('fails when the reference cookie points at an unknown key', async () => {
      const orphan = await encodeTicketRef('never-stored', SESSION_SECRET, SCHEME, 3600)
      const result = await handlerWith(store).authenticate(makeCtx({ cookies: { __oidc_session: orphan } }).ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('never leaks the failure reason to the client', async () => {
      const result = await handlerWith(store).authenticate(
        makeCtx({ cookies: { __oidc_session: await encodeTicketRef('gone', SESSION_SECRET, SCHEME, 3600) } }).ctx,
      )

      const error = result.error as { publicMessage?: string; message: string }
      expect(error.publicMessage).toBe('Authentication required')
      expect(error.message).toContain('Cannot read session cookie for "OIDC"')
    })
  })

  /**
   * The two cookie shapes are sealed under different purposes, each with its own derived key,
   * so neither can stand in for the other. That matters here because an inline session cookie
   * is a complete credential on its own — accepting one while a store is configured would
   * route straight around revocation.
   */
  describe('cookie purpose separation', () => {
    it('does not accept an inline session cookie when a store is configured', async () => {
      const inline = await encodeSession(
        claimsToSession([new Claim('sub', SUBJECT, ISSUER)], 'OIDC'),
        SESSION_SECRET,
        SCHEME,
        3600,
      )

      const result = await handlerWith(store).authenticate(makeCtx({ cookies: { __oidc_session: inline } }).ctx)
      expect(result.succeeded).toBe(false)
    })

    it('does not accept a ticket reference when no store is configured', async () => {
      const ref = await encodeTicketRef('some-key', SESSION_SECRET, SCHEME, 3600)

      const result = await handlerWith(undefined).authenticate(makeCtx({ cookies: { __oidc_session: ref } }).ctx)
      expect(result.succeeded).toBe(false)
    })
  })

  describe('without a ticket store', () => {
    it('still signs in with a self-contained session cookie', async () => {
      const handler = handlerWith(undefined)
      const sessionCookie = await signIn(handler)

      const result = await handler.authenticate(makeCtx({ cookies: { __oidc_session: sessionCookie } }).ctx)
      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe(SUBJECT)
    })
  })
})

describe('ticket key generation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('mints an unguessable key per sign-in rather than deriving one', async () => {
    // The key is the bearer credential for the session; the handler owns its generation so a
    // store implementation cannot substitute something predictable.
    const seen = new Set<string>()
    const capturing: RemoteAuthenticationTicketStore = {
      store: async (key: string) => void seen.add(key),
      retrieve: async () => undefined,
      remove: async () => {},
      removeBySubject: async () => {},
    }

    const pair = await generateKeyPair('RS256')
    const jwk = await exportJWK(pair.publicKey)
    const localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] })
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver: () => localJwks as JWTVerifyGetKey,
        ticketStore: capturing,
      }),
    )

    for (let i = 0; i < 3; i++) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, opts?: RequestInit) => {
          if (typeof url === 'string' && url.includes('.well-known')) {
            return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
          }
          if (opts?.method === 'POST') {
            const idToken = await new SignJWT({ sub: SUBJECT, nonce: 'n' })
              .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
              .setIssuer(ISSUER)
              .setAudience(CLIENT_ID)
              .setExpirationTime('1h')
              .sign(pair.privateKey)
            return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
          }
          return { ok: false, status: 404 }
        }),
      )

      const stateCookie = await encodeState(
        {
          state: 'st',
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
      const { ctx } = makeCtx({
        url: CALLBACK_PATH,
        cookies: { '__oidc_state.st': stateCookie },
        query: { code: 'c', state: 'st' },
      })
      await handler.processCallback(ctx)
    }

    vi.unstubAllGlobals()

    expect(seen.size).toBe(3)
    // 32 random bytes, base64url: 43 characters and no padding.
    for (const key of seen) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
  })
})

describe('RemoteAuthenticationTicket shape', () => {
  it('carries the session and the subject it is indexed by', async () => {
    const captured: RemoteAuthenticationTicket[] = []
    const capturing: RemoteAuthenticationTicketStore = {
      store: async (_key, ticket) => void captured.push(ticket),
      retrieve: async () => undefined,
      remove: async () => {},
      removeBySubject: async () => {},
    }

    const pair = await generateKeyPair('RS256')
    const jwk = await exportJWK(pair.publicKey)
    const localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('.well-known')) {
          return { ok: true, json: () => Promise.resolve(DISCOVERY_DOCUMENT) }
        }
        if (opts?.method === 'POST') {
          const idToken = await new SignJWT({ sub: SUBJECT, email: EMAIL, nonce: 'n' })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(ISSUER)
            .setAudience(CLIENT_ID)
            .setExpirationTime('1h')
            .sign(pair.privateKey)
          return { ok: true, json: () => Promise.resolve({ id_token: idToken }) }
        }
        return { ok: false, status: 404 }
      }),
    )

    // A claimMapper may legitimately drop `sub`, so the subject must come from the validated
    // id_token payload — otherwise the ticket would be unrevocable by user.
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver: () => localJwks as JWTVerifyGetKey,
        ticketStore: capturing,
        claimMapper: () => [new Claim('email', EMAIL, ISSUER)],
      }),
    )

    const stateCookie = await encodeState(
      {
        state: 'st',
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
    const { ctx } = makeCtx({
      url: CALLBACK_PATH,
      cookies: { '__oidc_state.st': stateCookie },
      query: { code: 'c', state: 'st' },
    })
    await handler.processCallback(ctx)
    vi.unstubAllGlobals()

    expect(captured).toHaveLength(1)
    expect(captured[0].subject).toBe(SUBJECT)
    expect(captured[0].session.claims.map(c => c.type)).toEqual(['email'])
  })
})

describe('RP-initiated logout', () => {
  const END_SESSION = `${ISSUER}/logout`
  let privateKey: CryptoKey
  let jwksResolver: (uri: string) => JWTVerifyGetKey
  let store: FakeTicketStore

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    const jwk = await exportJWK(pair.publicKey)
    const localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] })
    jwksResolver = () => localJwks as JWTVerifyGetKey
    store = new FakeTicketStore()
  })

  afterEach(() => vi.unstubAllGlobals())

  function mockFetch(nonce: string, discovery: Record<string, unknown> = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('.well-known')) {
          return {
            ok: true,
            json: () => Promise.resolve({ ...DISCOVERY_DOCUMENT, end_session_endpoint: END_SESSION, ...discovery }),
          }
        }
        if (opts?.method === 'POST') {
          const idToken = await new SignJWT({ sub: SUBJECT, email: EMAIL, nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(ISSUER)
            .setAudience(CLIENT_ID)
            .setExpirationTime('1h')
            .sign(privateKey)
          return { ok: true, json: () => Promise.resolve({ id_token: idToken, access_token: 'at' }) }
        }
        return { ok: false, status: 404 }
      }),
    )
  }

  async function signIn(handler: OIDCAuthenticationHandler, nonce = 'n', discovery = {}) {
    mockFetch(nonce, discovery)
    const stateCookie = await encodeState(
      { state: 'st', nonce, codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/', scheme: SCHEME, issuer: ISSUER },
      SESSION_SECRET,
      SCHEME,
    )
    const { ctx, cookie } = makeCtx({
      url: CALLBACK_PATH,
      cookies: { '__oidc_state.st': stateCookie },
      query: { code: 'c', state: 'st' },
    })
    await handler.processCallback(ctx)
    return cookie.mock.calls.find(c => c[0] === '__oidc_session')![1] as string
  }

  it('refuses to configure saveTokens without a ticket store', () => {
    // The alternative home for a refresh token is the session cookie, which the client holds.
    expect(() => new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ saveTokens: true }))).toThrow(
      'saveTokens requires a ticketStore',
    )
  })

  it('does not keep tokens unless asked', async () => {
    const handler = new OIDCAuthenticationHandler('OIDC', makeBaseOptions({ jwksResolver, ticketStore: store }))
    await signIn(handler)

    const ticket = [...store.tickets.values()][0]
    expect(ticket.tokens).toBeUndefined()
  })

  it('redirects to the provider with the id_token_hint', async () => {
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver,
        ticketStore: store,
        saveTokens: true,
        postLogoutRedirectURI: 'https://app.example.com/goodbye',
      }),
    )
    const sessionCookie = await signIn(handler)

    const { ctx, redirect } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
    await handler.signOutRedirect(ctx)

    const url = new URL(redirect.mock.calls[0][0] as string)
    expect(url.origin + url.pathname).toBe(END_SESSION)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('id_token_hint')).toBeTruthy()
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/goodbye')
  })

  /**
   * The whole point of the redirect. Ending only the local session leaves the provider's
   * alive, so the next sign-in re-authenticates with no prompt and the user believes they
   * signed out — on a shared machine the next person is one click from their account.
   */
  it('drops the local session as well as redirecting', async () => {
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver,
        ticketStore: store,
        saveTokens: true,
      }),
    )
    const sessionCookie = await signIn(handler)
    expect(store.tickets.size).toBe(1)

    const { ctx, deleteCookie } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
    await handler.signOutRedirect(ctx)

    expect(store.tickets.size).toBe(0)
    expect(deleteCookie).toHaveBeenCalledWith('__oidc_session', expect.any(Object))

    const after = await handler.authenticate(makeCtx({ cookies: { __oidc_session: sessionCookie } }).ctx)
    expect(after.succeeded).toBe(false)
  })

  it('still signs out locally when no tokens were saved', async () => {
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver,
        ticketStore: store,
      }),
    )
    const sessionCookie = await signIn(handler)

    const { ctx, redirect } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
    await handler.signOutRedirect(ctx)

    const url = new URL(redirect.mock.calls[0][0] as string)
    // Omitted rather than faked: sending some other session's token would be worse.
    expect(url.searchParams.get('id_token_hint')).toBeNull()
    expect(store.tickets.size).toBe(0)
  })

  it('reports a provider that advertises no end_session_endpoint', async () => {
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver,
        ticketStore: store,
      }),
    )
    await signIn(handler, 'n', { end_session_endpoint: undefined })

    await expect(handler.signOutRedirect(makeCtx().ctx)).rejects.toThrow('advertises no end_session_endpoint')
  })

  /**
   * Local sign-out must not depend on the IdP being reachable. With endSessionEndpoint
   * configured, no discovery is needed at all; the previous order resolved discovery first, so
   * a down /.well-known left the user fully authenticated behind a 500.
   */
  it('signs out locally even when the discovery endpoint is unreachable', async () => {
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver,
        ticketStore: store,
        saveTokens: true,
        discoveryCacheTtlSeconds: 0,
        endSessionEndpoint: END_SESSION,
      }),
    )
    const sessionCookie = await signIn(handler)
    expect(store.tickets.size).toBe(1)

    // The discovery endpoint is now down; a configured end-session URL must make it irrelevant.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('discovery endpoint is down')
      }),
    )

    const { ctx, redirect, deleteCookie } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
    await handler.signOutRedirect(ctx)

    expect(store.tickets.size).toBe(0)
    expect(deleteCookie).toHaveBeenCalledWith('__oidc_session', expect.any(Object))
    expect(new URL(redirect.mock.calls[0][0] as string).origin + '/logout').toContain('logout')
  })

  it('drops the local session even when no logout endpoint can be resolved', async () => {
    const handler = new OIDCAuthenticationHandler(
      'OIDC',
      makeBaseOptions({
        jwksResolver,
        ticketStore: store,
      }),
    )
    const sessionCookie = await signIn(handler, 'n', { end_session_endpoint: undefined })
    expect(store.tickets.size).toBe(1)

    // Revoke runs before the endpoint is resolved, so the ticket is gone even though the call
    // ultimately rejects for want of an end_session_endpoint.
    const { ctx } = makeCtx({ cookies: { __oidc_session: sessionCookie } })
    await expect(handler.signOutRedirect(ctx)).rejects.toThrow('advertises no end_session_endpoint')
    expect(store.tickets.size).toBe(0)
  })
})
