import { describe, it, expect, vi, afterEach } from 'vitest'

import type { Context } from '../../../../context.js'
import { Claim } from '../../../index.js'
import { AuthenticationBuilder } from '../../builder.js'
import { encodeSession, claimsToSession } from '../../internal/remote/session_store.js'
import { encodeState } from '../../internal/remote/state_store.js'
import { OAuth2AuthenticationHandler } from '../handler.js'
import { GITHUB_ENDPOINTS, githubOAuth2Preset } from './github.js'

const SESSION_SECRET = 'github-test-secret-at-least-32-chars!!'
const SCHEME = 'GitHub'
const CALLBACK_URL = 'https://app.example.com/auth/github'

function baseOptions(overrides: Record<string, unknown> = {}) {
  return githubOAuth2Preset({
    clientID: 'client',
    clientSecret: 'secret',
    sessionSecret: SESSION_SECRET,
    callbackURL: CALLBACK_URL,
    ...overrides,
  })
}

function makeCtx(
  overrides: Partial<{
    cookies: Record<string, string>
    query: Record<string, string>
    url: string
    headers: Record<string, string>
  }> = {},
) {
  const cookies = overrides.cookies ?? {}
  const query = overrides.query ?? {}
  // A browser navigation by default: a GitHub sign-in is one, and it is the branch of `challenge()` these
  // tests are about. The 401 branch has its own coverage in oidc/handler.test.ts.
  const headers = overrides.headers ?? { 'sec-fetch-mode': 'navigate' }
  const cookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const redirect = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()

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
    header,
    status: vi.fn(() => ctx),
  } as unknown as Context

  return { ctx, cookie, deleteCookie, redirect, header }
}

const USER = { id: 4242, login: 'octocat', name: 'The Octocat', email: null }

interface StubOptions {
  tokenBody?: string
  tokenStatus?: number
  user?: Record<string, unknown>
  emails?: unknown
}

function stubGithub(opts: StubOptions = {}) {
  const seen: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal | null }> = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal })

      if (url === GITHUB_ENDPOINTS.tokenEndpoint) {
        const body = opts.tokenBody ?? JSON.stringify({ access_token: 'gho_test', token_type: 'bearer' })
        return {
          ok: opts.tokenStatus === undefined || opts.tokenStatus < 400,
          status: opts.tokenStatus ?? 200,
          json: () => Promise.resolve(JSON.parse(body)),
        }
      }
      if (url === GITHUB_ENDPOINTS.userInfoEndpoint) {
        return { ok: true, status: 200, json: () => Promise.resolve(opts.user ?? USER) }
      }
      if (url === GITHUB_ENDPOINTS.emailsEndpoint) {
        return { ok: true, status: 200, json: () => Promise.resolve(opts.emails ?? []) }
      }
      return { ok: false, status: 404, json: () => Promise.resolve({}) }
    }),
  )

  return seen
}

async function stateCookie(issuer = 'https://github.com') {
  return encodeState(
    {
      state: 'st',
      nonce: 'n',
      codeVerifier: 'cv',
      pkceMethod: 'S256',
      returnTo: '/dashboard',
      scheme: SCHEME,
      issuer,
    },
    SESSION_SECRET,
    SCHEME,
  )
}

async function signIn(handler: OAuth2AuthenticationHandler) {
  const { ctx, cookie, redirect } = makeCtx({
    cookies: { [`${handler.stateCookieName}.st`]: await stateCookie() },
    query: { code: 'auth-code', state: 'st' },
  })
  await handler.processCallback(ctx)
  const call = cookie.mock.calls.find(c => c[0] === handler.sessionCookieName)
  return { cookieValue: call?.[1] as string, redirect }
}

describe('GitHub OAuth2 sign-in', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('signs a user in from the user info endpoint', async () => {
    stubGithub()
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())

    const { cookieValue, redirect } = await signIn(handler)
    expect(redirect).toHaveBeenCalledWith('/dashboard', 302)

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)

    expect(result.succeeded).toBe(true)
    // GitHub numbers its users. A number in the claim fails every reader of `sub` that takes a string: a refresh
    // token's subject, a remember-me series, `hasClaim('sub', '4242')`.
    expect(result.ticket!.principal.findFirst('sub')?.value).toBe('4242')
    expect(result.ticket!.principal.hasClaim('sub', '4242')).toBe(true)
    expect(result.ticket!.principal.findFirst('login')?.value).toBe('octocat')
  })

  it("does not let the provider name the caller's roles", async () => {
    // The user info body is unsigned JSON whose fields the provider chooses and whose values are often
    // whatever the user typed into their profile. Copying it wholesale — which is what the default mapper
    // used to do — puts a field called `roles` under the default roleClaimType, and `isInRole` reads it.
    stubGithub({ user: { id: 4242, login: 'octocat', roles: 'admin' } })
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())

    const { cookieValue } = await signIn(handler)
    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)

    expect(result.succeeded).toBe(true)
    expect(result.ticket!.principal.isInRole('admin')).toBe(false)
    expect(result.ticket!.principal.hasClaim('roles')).toBe(false)
  })

  it('maps only the allowlisted user info fields', async () => {
    stubGithub({ user: { id: 4242, login: 'octocat', name: 'Mona', gravatar_id: 'abc', company: '@github' } })
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())

    const { cookieValue } = await signIn(handler)
    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)

    const types = result
      .ticket!.principal.claims()
      .map(c => c.type)
      .sort()
    expect(types).toEqual(['login', 'name', 'sub'])
  })

  // The single most likely way a GitHub integration fails: without an explicit Accept header
  // the token endpoint answers form-encoded and every downstream error is misleading.
  it('asks the token endpoint for JSON', async () => {
    const seen = stubGithub()
    await signIn(new OAuth2AuthenticationHandler(SCHEME, baseOptions()))

    const tokenCall = seen.find(s => s.url === GITHUB_ENDPOINTS.tokenEndpoint)
    expect(tokenCall!.headers.Accept).toBe('application/json')
  })

  it('reports a form-encoded token response as a content-type problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === GITHUB_ENDPOINTS.tokenEndpoint) {
          return { ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token a')) }
        }
        return { ok: false, status: 404, json: () => Promise.resolve({}) }
      }),
    )

    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())
    const { ctx } = makeCtx({
      cookies: { [`${handler.stateCookieName}.st`]: await stateCookie() },
      query: { code: 'c', state: 'st' },
    })

    // Not "no access token" — that sends the reader looking at scopes and credentials.
    await expect(handler.processCallback(ctx)).rejects.toThrow('non-JSON body')
  })

  it('sends a User-Agent, which the GitHub API requires', async () => {
    const seen = stubGithub()
    await signIn(new OAuth2AuthenticationHandler(SCHEME, baseOptions()))

    const userCall = seen.find(s => s.url === GITHUB_ENDPOINTS.userInfoEndpoint)
    expect(userCall!.headers['User-Agent']).toBeDefined()
  })

  it('uses the immutable numeric id as the subject, not the renameable login', async () => {
    stubGithub()
    const captured: Array<{ subject: string }> = []
    const handler = new OAuth2AuthenticationHandler(
      SCHEME,
      baseOptions({
        ticketStore: {
          store: async (_k: string, t: { subject: string }) => void captured.push(t),
          retrieve: async () => undefined,
          remove: async () => {},
          removeBySubject: async () => {},
        },
      }),
    )

    await signIn(handler)
    expect(captured[0].subject).toBe('4242')
  })

  it('rejects a user info response with no subject field', async () => {
    stubGithub({ user: { login: 'octocat' } })
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())
    const { ctx } = makeCtx({
      cookies: { [`${handler.stateCookieName}.st`]: await stateCookie() },
      query: { code: 'c', state: 'st' },
    })

    await expect(handler.processCallback(ctx)).rejects.toThrow('has no "id" field')
  })

  // #10: OAuth2 binds the issuer (authorization endpoint origin) into state like OIDC does, and
  // the base now re-checks it. A code minted against a provider this handler no longer points at
  // must not be exchanged against the new one — the mix-up defense OIDC already had.
  it('rejects a callback whose state was minted against a different issuer', async () => {
    stubGithub()
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())
    const { ctx } = makeCtx({
      cookies: { [`${handler.stateCookieName}.st`]: await stateCookie('https://evil.example.com') },
      query: { code: 'auth-code', state: 'st' },
    })

    await expect(handler.processCallback(ctx)).rejects.toThrow('different issuer')
  })

  it('sends PKCE, which GitHub supports with S256 only', async () => {
    stubGithub()
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())
    const { ctx, redirect } = makeCtx()

    await handler.challenge(ctx)

    const url = new URL(redirect.mock.calls[0][0] as string)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
  })
})

describe('GitHub email enrichment', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches the verified primary email when asked', async () => {
    stubGithub({
      emails: [
        { email: 'other@example.com', primary: false, verified: true },
        { email: 'octocat@example.com', primary: true, verified: true },
      ],
    })

    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions({ includeEmail: true }))
    const { cookieValue } = await signIn(handler)

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)
    expect(result.ticket!.principal.findFirst('email')?.value).toBe('octocat@example.com')
  })

  // An account can hold an address it has never proven it owns; treating one as identity
  // would let a user claim someone else's email.
  it('ignores an unverified primary email', async () => {
    stubGithub({
      emails: [{ email: 'unverified@example.com', primary: true, verified: false }],
    })

    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions({ includeEmail: true }))
    const { cookieValue } = await signIn(handler)

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)
    expect(result.ticket!.principal.findFirst('email')).toBeUndefined()
  })

  /**
   * The email is an optional supplement, so a hung endpoint must not hold the sign-in open.
   * This call lives in the preset rather than the handler, which is exactly why it is easy to
   * leave without the deadline every other provider call in the flow carries.
   */
  it('bounds the emails request with a deadline', async () => {
    const seen = stubGithub({ emails: [{ email: 'a@b.com', primary: true, verified: true }] })
    await signIn(new OAuth2AuthenticationHandler(SCHEME, baseOptions({ includeEmail: true })))

    const emailCall = seen.find(s => s.url === GITHUB_ENDPOINTS.emailsEndpoint)
    expect(emailCall!.signal).toBeInstanceOf(AbortSignal)
  })

  it('signs the user in anyway when the emails endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === GITHUB_ENDPOINTS.emailsEndpoint) {
          throw new DOMException('The operation was aborted', 'TimeoutError')
        }
        if (url === GITHUB_ENDPOINTS.tokenEndpoint) {
          return { ok: true, status: 200, json: () => Promise.resolve({ access_token: 'gho_test' }) }
        }
        if (url === GITHUB_ENDPOINTS.userInfoEndpoint) {
          return { ok: true, status: 200, json: () => Promise.resolve(USER) }
        }
        return { ok: false, status: 404, json: () => Promise.resolve({}) }
      }),
    )

    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions({ includeEmail: true }))
    const { cookieValue } = await signIn(handler)

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)
    // Identity comes from /user; a missing optional email is not a reason to deny the login.
    expect(result.succeeded).toBe(true)
    expect(result.ticket!.principal.findFirst('email')).toBeUndefined()
  })

  it('does not call the emails endpoint unless asked', async () => {
    const seen = stubGithub()
    await signIn(new OAuth2AuthenticationHandler(SCHEME, baseOptions()))

    expect(seen.some(s => s.url === GITHUB_ENDPOINTS.emailsEndpoint)).toBe(false)
  })

  // Asking for the email is not a reason to lose the application's own enrichment, and an application that looks
  // a user up by email needs the one this found.
  it("runs the application's own enrichment too, after the email is in", async () => {
    stubGithub({ emails: [{ email: 'octocat@example.com', primary: true, verified: true }] })

    const enrichUserInfo = vi.fn((userInfo: Record<string, unknown>, _tokens: { accessToken?: string }) => ({
      ...userInfo,
      name: `${String(userInfo.email)} looked up`,
    }))

    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions({ includeEmail: true, enrichUserInfo }))
    const { cookieValue } = await signIn(handler)

    expect(enrichUserInfo).toHaveBeenCalledOnce()
    expect(enrichUserInfo.mock.calls[0][0]).toMatchObject({ id: 4242, email: 'octocat@example.com' })
    expect(enrichUserInfo.mock.calls[0][1]).toMatchObject({ accessToken: 'gho_test' })

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)
    expect(result.ticket!.principal.findFirst('email')?.value).toBe('octocat@example.com')
    expect(result.ticket!.principal.findFirst('name')?.value).toBe('octocat@example.com looked up')
  })

  it("runs the application's own enrichment alone when the email was not asked for", async () => {
    const seen = stubGithub()
    const enrichUserInfo = vi.fn((userInfo: Record<string, unknown>) => ({ ...userInfo, name: 'Enriched' }))

    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions({ enrichUserInfo }))
    const { cookieValue } = await signIn(handler)

    expect(seen.some(s => s.url === GITHUB_ENDPOINTS.emailsEndpoint)).toBe(false)

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookieValue } }).ctx)
    expect(result.ticket!.principal.findFirst('name')?.value).toBe('Enriched')
  })

  /**
   * A caller-supplied Authorization header must never displace the freshly exchanged access
   * token: if it did, every user would be resolved against the static token's account and all
   * receive the same identity. The bearer is spread last for exactly this reason.
   */
  it('does not let a caller header override the user info bearer token', async () => {
    const seen = stubGithub()
    await signIn(
      new OAuth2AuthenticationHandler(
        SCHEME,
        baseOptions({
          userInfoHeaders: { Authorization: 'token static-attacker-token' },
        }),
      ),
    )

    const userCall = seen.find(s => s.url === GITHUB_ENDPOINTS.userInfoEndpoint)
    expect(userCall!.headers.Authorization).toBe('Bearer gho_test')
  })
})

/**
 * The sealed cookies derive their keys from the strategy name, so this holds across protocols
 * as well as within one. It matters because an OIDC session is a complete credential: an
 * OAuth2 handler accepting one would bypass every id_token check that produced it.
 */
describe('cross-protocol isolation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not accept an OIDC session cookie sealed for another strategy', async () => {
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())
    const oidcCookie = await encodeSession(
      claimsToSession([new Claim('sub', 'u1', 'https://accounts.google.com')], 'Google'),
      SESSION_SECRET,
      'Google',
      3600,
    )

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: oidcCookie } }).ctx)
    expect(result.succeeded).toBe(false)
  })

  it('does not accept a session sealed for this strategy under another protocol name', async () => {
    const handler = new OAuth2AuthenticationHandler(SCHEME, baseOptions())
    // Same strategy name, so the key matches — the payload's scheme is what must still agree.
    const cookie = await encodeSession(
      claimsToSession([new Claim('sub', 'u1', 'https://github.com')], 'SomeOtherStrategy'),
      SESSION_SECRET,
      SCHEME,
      3600,
    )

    const result = await handler.authenticate(makeCtx({ cookies: { [handler.sessionCookieName]: cookie } }).ctx)
    expect(result.succeeded).toBe(false)
    expect(result.error).toBeUndefined()
  })
})

/**
 * The builder is the documented entry point, and it was never exercised: every test above
 * drives `githubOAuth2Preset` and the handler directly. `addGithub` resolved the options
 * before the preset could supply GitHub's endpoints, so the public method threw for every
 * caller — a bug no handler-level test could see.
 */
describe('builder registration', () => {
  it('addGithub configures without throwing', () => {
    expect(() =>
      new AuthenticationBuilder().addGithub('GitHub', o =>
        o.clientID('id').clientSecret('secret').sessionSecret(SESSION_SECRET).callbackURL(CALLBACK_URL),
      ),
    ).not.toThrow()
  })

  it('addGithub honours a preset option after configure', () => {
    expect(() =>
      new AuthenticationBuilder().addGithub(
        'GitHub',
        o => o.clientID('id').clientSecret('secret').sessionSecret(SESSION_SECRET).callbackURL(CALLBACK_URL),
        { includeEmail: true },
      ),
    ).not.toThrow()
  })

  it('addOAuth2 configures a fully specified provider without throwing', () => {
    // The handler constructor is the single resolution point; a second pass in the builder
    // would re-default and, historically, could reject an already-resolved object.
    expect(() =>
      new AuthenticationBuilder().addOAuth2('Custom', o =>
        o
          .clientID('id')
          .clientSecret('secret')
          .sessionSecret(SESSION_SECRET)
          .callbackURL(CALLBACK_URL)
          .authorizationEndpoint('https://p.example.com/auth')
          .tokenEndpoint('https://p.example.com/token')
          .userInfoEndpoint('https://p.example.com/me'),
      ),
    ).not.toThrow()
  })
})

/**
 * #15: the preset is also reachable with an already-resolved option bag (scopes: []), where
 * `?? default` does not fire because [] is not nullish. GitHub then gets an empty scope and
 * grants nothing — no user:email, so the email enrichment silently 403s.
 */
describe('githubOAuth2Preset scope defaulting', () => {
  it('defaults the scope when handed an empty array', () => {
    const opts = githubOAuth2Preset({
      clientID: 'id',
      clientSecret: 'secret',
      sessionSecret: SESSION_SECRET,
      callbackURL: CALLBACK_URL,
      scopes: [],
      includeEmail: true,
    })
    expect(opts.scopes).toContain('read:user')
    expect(opts.scopes).toContain('user:email')
  })

  it('respects an explicit non-empty scope', () => {
    const opts = githubOAuth2Preset({
      clientID: 'id',
      clientSecret: 'secret',
      sessionSecret: SESSION_SECRET,
      callbackURL: CALLBACK_URL,
      scopes: ['repo'],
    })
    expect(opts.scopes).toEqual(['repo'])
  })
})
