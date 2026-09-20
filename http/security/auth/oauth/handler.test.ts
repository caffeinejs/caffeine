import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { decodeState, encodeState, type RemoteAuthenticationState } from '../internal/remote/state_store.js'
import { OAuth2AuthenticationHandler } from './handler.js'
import type { OAuth2AuthenticationOptions } from './options.js'

const SESSION_SECRET = 'oauth2-test-secret-at-least-32-chars!!'
const SCHEME = 'Provider'
const PROVIDER = 'https://provider.example.com'
const STATE_COOKIE = '__oauth2_state'

function options(overrides: Partial<OAuth2AuthenticationOptions> = {}): OAuth2AuthenticationOptions {
  return {
    clientID: 'client id',
    clientSecret: 'secret/with+reserved:chars',
    sessionSecret: SESSION_SECRET,
    callbackURL: 'https://app.example.com/auth/provider',
    authorizationEndpoint: `${PROVIDER}/authorize`,
    tokenEndpoint: `${PROVIDER}/token`,
    userInfoEndpoint: `${PROVIDER}/me`,
    stateCookieName: STATE_COOKIE,
    ...overrides,
  }
}

const NAVIGATION: Record<string, string> = { 'sec-fetch-mode': 'navigate' }
const XHR: Record<string, string> = { accept: 'application/json' }

function makeCtx(
  overrides: Partial<{
    url: string
    cookies: Record<string, string>
    query: Record<string, string>
    headers: Record<string, string>
  }> = {},
) {
  const cookies = overrides.cookies ?? {}
  const query = overrides.query ?? {}
  const headers = overrides.headers ?? NAVIGATION
  const cookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const redirect = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()
  const body = vi.fn().mockReturnThis()

  const ctx = {
    req: {
      url: overrides.url ?? '/api/me',
      cookie: (name?: string) => (name === undefined ? cookies : cookies[name]),
      query: (key?: string) => (key === undefined ? query : query[key]),
      header: (name?: string) => (name === undefined ? headers : headers[name]),
    },
    cookie,
    deleteCookie,
    redirect,
    header,
    body,
    status: vi.fn(() => ctx),
  } as unknown as Context

  return { ctx, cookie, deleteCookie, redirect, header, body }
}

type Mocks = ReturnType<typeof makeCtx>

/** The state cookies a response set, as the browser would send them back. */
function cookiesSetBy({ cookie }: Mocks): Record<string, string> {
  return Object.fromEntries(
    (cookie.mock.calls as Array<[string, string]>)
      .filter(([name]) => name.startsWith(`${STATE_COOKIE}.`))
      .map(([name, value]) => [name, value]),
  )
}

function loginURL({ body, redirect }: Mocks): URL {
  const answered = body.mock.calls[0]?.[0] as { loginURL: string } | undefined
  return new URL(answered?.loginURL ?? (redirect.mock.calls[0] as [string])[0])
}

function sealed(state: Partial<RemoteAuthenticationState>): Promise<string> {
  return encodeState(
    {
      state: 'st',
      nonce: 'n',
      codeVerifier: 'cv',
      pkceMethod: 'S256',
      returnTo: '/api/me',
      scheme: SCHEME,
      issuer: PROVIDER,
      ...state,
    },
    SESSION_SECRET,
    SCHEME,
  )
}

describe('OAuth2AuthenticationHandler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // A signed-out page that polls an API is challenged on every poll. A state cookie per challenge, each good for
  // ten minutes, outgrows the request headers a server accepts, and then every request to the origin is refused,
  // the sign-in page included.
  describe('challenge() — the flows a browser has under way', () => {
    it('hands a challenge answered with a status the flow the last one started', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const first = makeCtx({ headers: XHR })
      await handler.challenge(first.ctx)

      const again = makeCtx({ headers: XHR, cookies: cookiesSetBy(first) })
      await handler.challenge(again.ctx)

      expect(Object.keys(cookiesSetBy(first))).toHaveLength(1)
      expect(cookiesSetBy(again)).toEqual({})
      expect(loginURL(again).toString()).toBe(loginURL(first).toString())
    })

    it('holds one state cookie however often a signed-out page polls', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      let jar: Record<string, string> = {}
      for (let poll = 0; poll < 50; poll++) {
        const mocks = makeCtx({ headers: XHR, cookies: jar })
        await handler.challenge(mocks.ctx)
        jar = { ...jar, ...cookiesSetBy(mocks) }
      }

      expect(Object.keys(jar)).toHaveLength(1)
    })

    // The flow handed out again has to be one the callback would still complete.
    it('completes a sign-in through a flow that was handed out more than once', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve(url.endsWith('/token') ? { access_token: 'at' } : { id: 7 }),
        })),
      )

      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const first = makeCtx({ headers: XHR })
      await handler.challenge(first.ctx)
      const again = makeCtx({ headers: XHR, cookies: cookiesSetBy(first) })
      await handler.challenge(again.ctx)

      const callback = makeCtx({
        cookies: cookiesSetBy(first),
        query: { code: 'c', state: loginURL(again).searchParams.get('state')! },
      })
      await handler.processCallback(callback.ctx)

      expect(callback.redirect).toHaveBeenCalledWith('/api/me', 302)
    })

    // A navigation's state rides a redirect the browser follows, never a body a script reads. Handing it to the
    // next poll would put it in one.
    it('never hands the flow of a navigation to a challenge answered with a status', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const navigation = makeCtx({ headers: NAVIGATION })
      await handler.challenge(navigation.ctx)

      const poll = makeCtx({ headers: XHR, cookies: cookiesSetBy(navigation) })
      await handler.challenge(poll.ctx)

      expect(Object.keys(cookiesSetBy(poll))).toHaveLength(1)
      expect(loginURL(poll).searchParams.get('state')).not.toBe(loginURL(navigation).searchParams.get('state'))
    })

    it('starts a flow of its own for every navigation, so two tabs can both sign in', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const first = makeCtx({ headers: NAVIGATION })
      await handler.challenge(first.ctx)
      const second = makeCtx({ headers: NAVIGATION, cookies: cookiesSetBy(first) })
      await handler.challenge(second.ctx)

      expect(Object.keys(cookiesSetBy(second))).toHaveLength(1)
      expect(loginURL(second).searchParams.get('state')).not.toBe(loginURL(first).searchParams.get('state'))
    })

    // The flow remembers where to send the user afterwards, so it only stands in for a challenge of the same URL.
    it('does not hand out a flow that returns somewhere else', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const first = makeCtx({ headers: XHR, url: '/api/me' })
      await handler.challenge(first.ctx)
      const other = makeCtx({ headers: XHR, url: '/api/orders', cookies: cookiesSetBy(first) })
      await handler.challenge(other.ctx)

      const [name] = Object.keys(cookiesSetBy(other))
      const state = await decodeState(cookiesSetBy(other)[name], SESSION_SECRET, SCHEME)
      expect(state.returnTo).toBe('/api/orders')
    })

    it('does not hand out a flow with too little of its ten minutes left to sign in with', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const first = makeCtx({ headers: XHR })
      await handler.challenge(first.ctx)

      vi.setSystemTime(Date.now() + 7 * 60_000)
      const stillGood = makeCtx({ headers: XHR, cookies: cookiesSetBy(first) })
      await handler.challenge(stillGood.ctx)
      expect(cookiesSetBy(stillGood)).toEqual({})

      vi.setSystemTime(Date.now() + 2 * 60_000)
      const tooLate = makeCtx({ headers: XHR, cookies: cookiesSetBy(first) })
      await handler.challenge(tooLate.ctx)
      expect(Object.keys(cookiesSetBy(tooLate))).toHaveLength(1)
    })

    it('does not hand out a flow started against another provider', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const poll = makeCtx({
        headers: XHR,
        cookies: { [`${STATE_COOKIE}.st`]: await sealed({ reusable: true, issuer: 'https://elsewhere.example.com' }) },
      })
      await handler.challenge(poll.ctx)

      expect(loginURL(poll).searchParams.get('state')).not.toBe('st')
    })

    it('starts a new flow past a state cookie it cannot open', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const poll = makeCtx({ headers: XHR, cookies: { [`${STATE_COOKIE}.junk`]: 'not-a-sealed-state' } })
      await handler.challenge(poll.ctx)

      expect(Object.keys(cookiesSetBy(poll))).toHaveLength(1)
      expect(loginURL(poll).searchParams.get('state')).not.toBe('junk')
    })

    // The backstop for what reuse does not cover: tab after tab of navigations, each with a flow of its own.
    it('clears the flows nobody finished once a browser holds eight of them', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const held: Record<string, string> = {}
      for (let tab = 0; tab < 8; tab++) {
        held[`${STATE_COOKIE}.tab${tab}`] = await sealed({ state: `tab${tab}` })
      }

      const seven = makeCtx({ cookies: Object.fromEntries(Object.entries(held).slice(0, 7)) })
      await handler.challenge(seven.ctx)
      expect(seven.deleteCookie).not.toHaveBeenCalled()

      const eight = makeCtx({ cookies: held })
      await handler.challenge(eight.ctx)

      expect((eight.deleteCookie.mock.calls as Array<[string]>).map(([name]) => name).toSorted()).toEqual(
        Object.keys(held).toSorted(),
      )
      expect(Object.keys(cookiesSetBy(eight))).toHaveLength(1)
    })

    it('leaves the state cookies of another strategy alone', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      const others = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`__other_state.flow${i}`, 'x']))
      const mocks = makeCtx({ cookies: others })
      await handler.challenge(mocks.ctx)

      expect(mocks.deleteCookie).not.toHaveBeenCalled()
    })
  })

  describe('processCallback() — what the provider sends back', () => {
    // It arrives on a URL anyone can craft, and it is written to the log.
    it('does not repeat an error code outside the character set RFC 6749 gives it', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())

      for (const error of ['access_denied\n2026-09-20 ERROR forged entry', 'say "hi"', 'back\\slash', 'x'.repeat(65)]) {
        const { ctx } = makeCtx({ query: { error, state: 'st' } })

        const failure = (await handler.processCallback(ctx).catch((e: unknown) => e)) as Error
        expect(failure.message).toContain('provider returned "(malformed error code)"')
        expect(failure.message).not.toContain('forged')
      }
    })

    it('repeats a well-formed error code', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())
      const { ctx } = makeCtx({ query: { error: 'access_denied', state: 'st' } })

      await expect(handler.processCallback(ctx)).rejects.toThrow('provider returned "access_denied"')
    })

    // A flow that came back is over, whichever way it went. Its cookie is otherwise good for the rest of its ten
    // minutes, with a state that has now been seen in a URL.
    it('clears the state cookie when the provider refused', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())
      const { ctx, deleteCookie } = makeCtx({
        cookies: { [`${STATE_COOKIE}.st`]: await sealed({}) },
        query: { error: 'access_denied', state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow()

      expect(deleteCookie).toHaveBeenCalledWith(`${STATE_COOKIE}.st`, expect.objectContaining({ path: '/' }))
    })

    it('clears the state cookie when the code is missing', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())
      const { ctx, deleteCookie } = makeCtx({
        cookies: { [`${STATE_COOKIE}.st`]: await sealed({}) },
        query: { state: 'st' },
      })

      await expect(handler.processCallback(ctx)).rejects.toThrow('missing code parameter')

      expect(deleteCookie).toHaveBeenCalledWith(`${STATE_COOKIE}.st`, expect.objectContaining({ path: '/' }))
    })

    // The state names the cookie to clear, so one that could not have been minted here names none.
    it('clears nothing for a state it could not have minted', async () => {
      const handler = new OAuth2AuthenticationHandler(SCHEME, options())
      const { ctx, deleteCookie } = makeCtx({ query: { code: 'c', state: '../../session' } })

      await expect(handler.processCallback(ctx)).rejects.toThrow('missing or malformed state parameter')

      expect(deleteCookie).not.toHaveBeenCalled()
    })
  })

  describe('token endpoint client authentication', () => {
    interface TokenRequest {
      headers: Record<string, string>
      body: URLSearchParams
    }

    function stubProvider(): TokenRequest[] {
      const requests: TokenRequest[] = []

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith('/token')) {
            requests.push({ headers: init?.headers as Record<string, string>, body: init?.body as URLSearchParams })
            return { ok: true, status: 200, json: () => Promise.resolve({ access_token: 'at' }) }
          }
          return { ok: true, status: 200, json: () => Promise.resolve({ id: 'u1' }) }
        }),
      )

      return requests
    }

    async function signIn(handler: OAuth2AuthenticationHandler): Promise<void> {
      const { ctx } = makeCtx({
        cookies: { [`${STATE_COOKIE}.st`]: await sealed({}) },
        query: { code: 'c', state: 'st' },
      })
      await handler.processCallback(ctx)
    }

    it('sends the credentials in the body unless told otherwise', async () => {
      const requests = stubProvider()

      await signIn(new OAuth2AuthenticationHandler(SCHEME, options()))

      expect(requests[0].body.get('client_id')).toBe('client id')
      expect(requests[0].body.get('client_secret')).toBe('secret/with+reserved:chars')
      expect(requests[0].headers.Authorization).toBeUndefined()
    })

    // RFC 6749 §2.3.1: form-urlencoded first, then joined and base64-encoded. A secret holding a colon or a plus
    // reaches a strict server as another secret otherwise.
    it('sends them as HTTP Basic, and keeps the secret out of the body, for client_secret_basic', async () => {
      const requests = stubProvider()

      await signIn(new OAuth2AuthenticationHandler(SCHEME, options({ tokenEndpointAuthMethod: 'client_secret_basic' })))

      const credentials = Buffer.from(requests[0].headers.Authorization.replace('Basic ', ''), 'base64').toString()
      expect(credentials).toBe('client+id:secret%2Fwith%2Breserved%3Achars')
      expect(requests[0].body.has('client_secret')).toBe(false)
      expect(requests[0].body.has('client_id')).toBe(false)
    })

    it('does not let a configured token request header replace the credentials', async () => {
      const requests = stubProvider()

      await signIn(
        new OAuth2AuthenticationHandler(
          SCHEME,
          options({
            tokenEndpointAuthMethod: 'client_secret_basic',
            tokenRequestHeaders: { Authorization: 'Basic x' },
          }),
        ),
      )

      expect(requests[0].headers.Authorization).not.toBe('Basic x')
    })
  })

  describe('the subject claim', () => {
    // A provider that numbers its users. Every reader of `sub` takes a string: a refresh token's subject, a
    // remember-me series, `hasClaim('sub', '583231')`.
    it('is a string, as the ticket subject is, when the provider sends a number', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve(url.endsWith('/token') ? { access_token: 'at' } : { id: 583231, followers: 12 }),
        })),
      )

      const handler = new OAuth2AuthenticationHandler(
        SCHEME,
        options({ claimActions: { map: { followers: 'followers' } } }),
      )
      const callback = makeCtx({
        cookies: { [`${STATE_COOKIE}.st`]: await sealed({}) },
        query: { code: 'c', state: 'st' },
      })
      await handler.processCallback(callback.ctx)

      const session = (callback.cookie.mock.calls as Array<[string, string]>).find(
        ([name]) => name === handler.sessionCookieName,
      )!
      const result = await handler.authenticate(makeCtx({ cookies: { [session[0]]: session[1] } }).ctx)

      expect(result.ticket!.principal.findFirst('sub')?.value).toBe('583231')
      expect(result.ticket!.principal.hasClaim('sub', '583231')).toBe(true)
      // Only the identifier: a number that is a number stays one.
      expect(result.ticket!.principal.findFirst('followers')?.value).toBe(12)
    })
  })
})
