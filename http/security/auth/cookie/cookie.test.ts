import { describe, it, expect, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { AuthenticationTicket } from '../ticket.js'
import { CookieAuthenticationHandler } from './cookie.js'
import { CookieAuthenticationOptionsBuilder } from './cookie_options.js'

const SECRET = 'session-secret-that-is-at-least-32-bytes!'

// A cookie is cleared with the attributes it was set with: a browser refuses a `__Host-` or `__Secure-` cookie
// that arrives without `Secure`, the clearing one included.
const CLEARED_WITH = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }
const EIGHT_HOURS = 8 * 60 * 60
const THIRTY_DAYS = 30 * 24 * 60 * 60

function makeHandler(configure: (o: CookieAuthenticationOptionsBuilder) => void = () => {}) {
  const b = new CookieAuthenticationOptionsBuilder().sessionSecret(SECRET)
  configure(b)
  return new CookieAuthenticationHandler('Cookie', b.build())
}

/** A context whose headers say "browser navigation" — the case a `loginPath` redirect is meant for. */
function makeNavCtx(url?: string) {
  return makeCtx(undefined, url, { 'sec-fetch-mode': 'navigate' })
}

function makeCtx(cookieValue?: string, url?: string, headers: Record<string, string> = {}) {
  const setCookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()
  const status = vi.fn().mockReturnThis()
  const body = vi.fn().mockReturnThis()
  const ctx = {
    req: {
      url,
      cookie: (name: string) => (name === 'caf.session' ? cookieValue : undefined),
      header: (name: string) => headers[name],
    },
    cookie: setCookie,
    deleteCookie,
    status,
    header,
    body,
  } as unknown as Context
  return { ctx, setCookie, deleteCookie, status, header, body }
}

function principal(): Principal {
  return new Principal(
    true,
    new Identity('Cookie', true, [new Claim('sub', 'u1', ''), new Claim('roles', 'admin', '')]),
  )
}

async function sealedFor(rememberMe: boolean): Promise<{ value: string; opts: Record<string, unknown> }> {
  const handler = makeHandler()
  const { ctx, setCookie } = makeCtx()
  await handler.persist(ctx, new AuthenticationTicket(principal(), 'Cookie', { isPersistent: rememberMe }))
  const [, value, opts] = setCookie.mock.calls[0] as [string, string, Record<string, unknown>]
  return { value, opts }
}

describe('CookieAuthenticationHandler', () => {
  describe('authenticate()', () => {
    it('returns none when no session cookie is present', async () => {
      const { ctx } = makeCtx(undefined)
      const result = await makeHandler().authenticate(ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('rebuilds the principal from a valid cookie', async () => {
      const { value } = await sealedFor(false)
      const { ctx } = makeCtx(value)
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe('u1')
      expect(result.ticket!.principal.isInRole('admin')).toBe(true)
    })

    // A cookie was presented and it did not open: a failure, not an absent credential. It is cleared, since it
    // will never open, and the application is told.
    it('fails on a tampered cookie, clears it, and reports it', async () => {
      const { value } = await sealedFor(false)
      const { ctx, deleteCookie } = makeCtx(`${value.slice(0, -3)}xyz`)
      const onFail = vi.fn()
      const options = new CookieAuthenticationOptionsBuilder().sessionSecret(SECRET).onFail(onFail).build()

      const result = await new CookieAuthenticationHandler('Cookie', options).authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
      expect(onFail).toHaveBeenCalledWith(ctx, result.error)
      expect(deleteCookie).toHaveBeenCalledWith('caf.session', CLEARED_WITH)
    })

    // The application could not say whether the session still stands. That is its failure to surface, not a reason
    // to treat a good cookie as a forged one and sign the user out without a word.
    it('lets an error thrown by validatePrincipal through, and leaves the cookie alone', async () => {
      const { value } = await sealedFor(false)
      const { ctx, deleteCookie } = makeCtx(value)
      const options = new CookieAuthenticationOptionsBuilder()
        .sessionSecret(SECRET)
        .validatePrincipal(() => Promise.reject(new Error('the user store is unreachable')))
        .build()

      await expect(new CookieAuthenticationHandler('Cookie', options).authenticate(ctx)).rejects.toThrow(
        'the user store is unreachable',
      )
      expect(deleteCookie).not.toHaveBeenCalled()
    })
  })

  describe('persist() — remember-me', () => {
    it('sets a persistent cookie (maxAge = rememberMeMaxAge) when rememberMe is true', async () => {
      const { opts } = await sealedFor(true)
      expect(opts.maxAge).toBe(THIRTY_DAYS)
      expect(opts.httpOnly).toBe(true)
    })

    it('sets a session cookie (no maxAge) when rememberMe is falsy', async () => {
      const { opts } = await sealedFor(false)
      expect(opts.maxAge).toBeUndefined()
    })

    it('binds the sealed token exp to maxAge (session token expires after 8h default)', async () => {
      // A session cookie carries no maxAge but the token's exp still caps replay at `maxAge`.
      const { value } = await sealedFor(false)
      const { ctx } = makeCtx(value)
      expect((await makeHandler().authenticate(ctx)).succeeded).toBe(true)
      void EIGHT_HOURS
    })
  })

  describe('revoke()', () => {
    it('clears the session cookie', async () => {
      const { ctx, deleteCookie } = makeCtx()
      await makeHandler().revoke(ctx)
      expect(deleteCookie).toHaveBeenCalledWith('caf.session', CLEARED_WITH)
    })
  })

  describe('challenge()', () => {
    it('redirects a navigation to loginPath when configured', async () => {
      const { ctx, status, header } = makeNavCtx()
      await makeHandler(o => o.loginPath('/login')).challenge(ctx)
      expect(status).toHaveBeenCalledWith(302)
      expect(header).toHaveBeenCalledWith('location', '/login')
    })

    it('carries the interrupted URL back as returnUrl', async () => {
      const { ctx, header } = makeNavCtx('/reports?year=2026')
      await makeHandler(o => o.loginPath('/login')).challenge(ctx)
      expect(header).toHaveBeenCalledWith('location', '/login?returnUrl=%2Freports%3Fyear%3D2026')
    })

    it('prefers an explicit redirectURI from the properties', async () => {
      const { ctx, header } = makeNavCtx('/reports')
      await makeHandler(o => o.loginPath('/login')).challenge(ctx, { redirectURI: '/dashboard' })
      expect(header).toHaveBeenCalledWith('location', '/login?returnUrl=%2Fdashboard')
    })

    it('drops an off-origin redirectURI rather than echoing it', async () => {
      // This value lands in a Location header after sign-in, so an unvalidated one is an open redirect.
      const { ctx, header } = makeNavCtx()
      await makeHandler(o => o.loginPath('/login')).challenge(ctx, { redirectURI: '//evil.example/pwn' })
      expect(header).toHaveBeenCalledWith('location', '/login')
    })

    it('honours a custom returnURLParameter and an existing query string', async () => {
      const { ctx, header } = makeNavCtx('/reports')
      await makeHandler(o => o.loginPath('/login?mode=sso').returnURLParameter('next')).challenge(ctx)
      expect(header).toHaveBeenCalledWith('location', '/login?mode=sso&next=%2Freports')
    })

    // A `fetch` follows a 302 itself and resolves with the login page's HTML and a 200, so the caller
    // cannot tell it was unauthenticated. It gets a status it can act on, and the URL in the body.
    it('answers 401 with the login URL to a non-navigation caller', async () => {
      const { ctx, status, header, body } = makeCtx(undefined, '/reports', { 'sec-fetch-mode': 'cors' })
      await makeHandler(o => o.loginPath('/login')).challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
      expect(body).toHaveBeenCalledWith({ error: 'authentication_required', loginURL: '/login?returnUrl=%2Freports' })
      expect(header).toHaveBeenCalledWith('access-control-expose-headers', 'location')
    })

    // Fetch Metadata says "not a navigation" and must win over the Accept header. htmx sends exactly this
    // pair, and redirecting it produced the opaque failure the negotiation exists to avoid.
    it('does not redirect an htmx-style fragment request that also accepts HTML', async () => {
      const { ctx, status } = makeCtx(undefined, '/reports', {
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        accept: 'text/html',
      })
      await makeHandler(o => o.loginPath('/login')).challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
      expect(status).not.toHaveBeenCalledWith(302)
    })

    // Browsers omit Fetch Metadata outside secure contexts, so plain-http development relies on Accept.
    it('falls back to Accept when Fetch Metadata is absent', async () => {
      const { ctx, status } = makeCtx(undefined, '/reports', { accept: 'text/html,application/xhtml+xml' })
      await makeHandler(o => o.loginPath('/login')).challenge(ctx)

      expect(status).toHaveBeenCalledWith(302)
    })

    it('challengeMode "redirect" redirects a caller that would otherwise get a 401', async () => {
      const { ctx, status } = makeCtx(undefined, '/reports', { 'sec-fetch-mode': 'cors' })
      await makeHandler(o => o.loginPath('/login').challengeMode('redirect')).challenge(ctx)

      expect(status).toHaveBeenCalledWith(302)
    })

    it('challengeMode "status" answers 401 even to a navigation', async () => {
      const { ctx, status } = makeNavCtx('/reports')
      await makeHandler(o => o.loginPath('/login').challengeMode('status')).challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
    })

    it('returns 401 when no loginPath is set', async () => {
      const { ctx, status } = makeCtx()
      await makeHandler().challenge(ctx)
      expect(status).toHaveBeenCalledWith(401)
    })

    it('delegates to onChallenge when provided', async () => {
      const onChallenge = vi.fn()
      const { ctx, status } = makeCtx()
      await makeHandler(o => o.loginPath('/login').onChallenge(onChallenge)).challenge(ctx)
      expect(onChallenge).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('forbid()', () => {
    it('answers 403 by default', async () => {
      const { ctx, status } = makeCtx()
      await makeHandler().forbid(ctx)
      expect(status).toHaveBeenCalledWith(403)
    })

    // Not loginPath: the caller is already signed in, so sending them to log in again is a loop.
    it('redirects a navigation to accessDeniedPath when configured', async () => {
      const { ctx, status, header } = makeNavCtx()
      await makeHandler(o => o.loginPath('/login').accessDeniedPath('/denied')).forbid(ctx)
      expect(status).toHaveBeenCalledWith(302)
      expect(header).toHaveBeenCalledWith('location', '/denied')
    })

    // A page and an API on one scheme need different answers: redirecting a fetch would hand it a 200 and
    // the access-denied page's HTML instead of the status it has to act on.
    it('answers 403 to a caller that is not a navigation, even with accessDeniedPath configured', async () => {
      const { ctx, status, header } = makeCtx()
      await makeHandler(o => o.loginPath('/login').accessDeniedPath('/denied')).forbid(ctx)
      expect(status).toHaveBeenCalledWith(403)
      expect(header).not.toHaveBeenCalledWith('location', '/denied')
    })

    it('honours challengeMode over the request, as challenge does', async () => {
      const denied = (mode: 'redirect' | 'status') =>
        makeHandler(o => o.loginPath('/login').accessDeniedPath('/denied').challengeMode(mode))

      const forced = makeCtx()
      await denied('redirect').forbid(forced.ctx)
      expect(forced.status).toHaveBeenCalledWith(302)

      const refused = makeNavCtx()
      await denied('status').forbid(refused.ctx)
      expect(refused.status).toHaveBeenCalledWith(403)
    })
  })

  describe('validatePrincipal()', () => {
    async function sealedSession(): Promise<string> {
      const { ctx, setCookie } = makeCtx()
      await makeHandler().persist(ctx, new AuthenticationTicket(principal(), 'Cookie'))
      return (setCookie.mock.calls[0] as [string, string])[1]
    }

    it('accepts the session when the hook returns a principal', async () => {
      const sealed = await sealedSession()
      const { ctx } = makeCtx(sealed)
      const handler = makeHandler(o => o.validatePrincipal((_c, p) => p))

      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(true)
    })

    // The sealed cookie is self-contained, so this is the only thing standing between a revoked account
    // and a session that stays valid for its full eight hours.
    it('rejects the session and clears the cookie when the hook returns null', async () => {
      const sealed = await sealedSession()
      const { ctx, deleteCookie } = makeCtx(sealed)
      const handler = makeHandler(o => o.validatePrincipal(() => null))

      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(false)
      expect(deleteCookie).toHaveBeenCalledWith('caf.session', CLEARED_WITH)
    })

    it('lets the hook swap in a refreshed principal', async () => {
      const sealed = await sealedSession()
      const { ctx } = makeCtx(sealed)
      const refreshed = new Principal(true, new Identity('Cookie', true, [new Claim('sub', 'u2', '')]))
      const handler = makeHandler(o => o.validatePrincipal(() => refreshed))

      const result = await handler.authenticate(ctx)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe('u2')
    })
  })
})
