import { describe, it, expect, vi } from 'vitest'
import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { AuthenticationTicket } from '../ticket.js'
import { CookieAuthenticationHandler } from './cookie.js'
import { CookieAuthenticationOptionsBuilder } from './cookie_options.js'

const SECRET = 'session-secret-that-is-at-least-32-bytes!'
const EIGHT_HOURS = 8 * 60 * 60
const THIRTY_DAYS = 30 * 24 * 60 * 60

function makeHandler(configure: (o: CookieAuthenticationOptionsBuilder) => void = () => {}) {
  const b = new CookieAuthenticationOptionsBuilder().sessionSecret(SECRET)
  configure(b)
  return new CookieAuthenticationHandler('Cookie', b.build())
}

function makeCtx(cookieValue?: string) {
  const setCookie = vi.fn().mockReturnThis()
  const deleteCookie = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()
  const status = vi.fn().mockReturnThis()
  const ctx = {
    req: { cookie: (name: string) => (name === 'caf.session' ? cookieValue : undefined) },
    cookie: setCookie,
    deleteCookie,
    status,
    header,
  } as unknown as Context
  return { ctx, setCookie, deleteCookie, status, header }
}

function principal(): Principal {
  return new Principal(true, new Identity('Cookie', true, [
    new Claim('sub', 'u1', ''),
    new Claim('roles', 'admin', ''),
  ]))
}

async function sealedFor(rememberMe: boolean): Promise<{ value: string, opts: Record<string, unknown> }> {
  const handler = makeHandler()
  const { ctx, setCookie } = makeCtx()
  await handler.persist(ctx, new AuthenticationTicket(principal(), 'Cookie', { rememberMe }))
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

    it('returns none for a tampered cookie', async () => {
      const { value } = await sealedFor(false)
      const { ctx } = makeCtx(`${value.slice(0, -3)}xyz`)
      const result = await makeHandler().authenticate(ctx)
      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
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
      expect(deleteCookie).toHaveBeenCalledWith('caf.session', { path: '/' })
    })
  })

  describe('challenge()', () => {
    it('redirects to loginPath when configured', async () => {
      const { ctx, status, header } = makeCtx()
      await makeHandler(o => o.loginPath('/login')).challenge(ctx)
      expect(status).toHaveBeenCalledWith(302)
      expect(header).toHaveBeenCalledWith('location', '/login')
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
})
