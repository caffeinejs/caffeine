import { describe, it, expect, vi } from 'vitest'
import { SignJWT } from 'jose'
import type { Context } from '../../../context.js'
import { JWTAuthenticationHandler } from './jwt.js'

const SECRET = 'test-secret-key-must-be-at-least-32-chars!!'
const secretBytes = new TextEncoder().encode(SECRET)

function makeCtx(authHeader?: string) {
  const status = vi.fn().mockReturnThis()
  const header = vi.fn().mockReturnThis()
  const ctx = {
    req: { header: (name: string) => (name === 'authorization' ? authHeader : undefined) },
    status,
    header,
  } as unknown as Context
  return { ctx, status, header }
}

async function sign(
  payload: Record<string, unknown>,
  opts: { issuer?: string, audience?: string } = {},
) {
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
  if (opts.issuer) {
    builder = builder.setIssuer(opts.issuer)
  }
  if (opts.audience) {
    builder = builder.setAudience(opts.audience)
  }
  return builder.sign(secretBytes)
}

async function signExpired(payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() - 1000))
    .sign(secretBytes)
}

function makeHandler(overrides: Record<string, unknown> = {}) {
  return new JWTAuthenticationHandler('Bearer', { secret: SECRET, ...overrides })
}

describe('JWTAuthenticationHandler', () => {
  describe('authenticate()', () => {
    it('returns none when Authorization header is absent', async () => {
      const { ctx } = makeCtx(undefined)
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns none when Authorization header does not start with "Bearer "', async () => {
      const { ctx } = makeCtx('Basic dXNlcjpwYXNz')
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns success and populates principal claims for a valid token', async () => {
      const token = await sign({ sub: 'alice' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal.findFirst('sub')?.value).toBe('alice')
    })

    it('sets scheme name on the ticket', async () => {
      const handler = new JWTAuthenticationHandler('my-scheme', { secret: SECRET })
      const token = await sign({ sub: 'u1' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await handler.authenticate(ctx)

      expect(result.ticket!.scheme).toBe('my-scheme')
    })

    it('returns fail with error for a malformed token', async () => {
      const { ctx } = makeCtx('Bearer not.a.valid.jwt')
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns fail for an expired token', async () => {
      const token = await signExpired({ sub: 'user' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns fail when issuer does not match', async () => {
      const handler = new JWTAuthenticationHandler('Bearer', {
        secret: SECRET,
        jwtOptions: { issuer: 'https://expected.example.com', algorithms: ['HS256'] },
      })
      const token = await sign({ sub: 'u1' }, { issuer: 'https://other.example.com' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns fail when audience does not match', async () => {
      const handler = new JWTAuthenticationHandler('Bearer', {
        secret: SECRET,
        jwtOptions: { audience: 'my-api', algorithms: ['HS256'] },
      })
      const token = await sign({ sub: 'u1' }, { audience: 'other-api' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await handler.authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('maps a scalar roles claim so isInRole works', async () => {
      const token = await sign({ sub: 'u1', roles: 'admin' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await makeHandler().authenticate(ctx)

      expect(result.ticket!.principal.isInRole('admin')).toBe(true)
    })

    it('maps an array roles claim so isInRole works for each value', async () => {
      const token = await sign({ sub: 'u1', roles: ['admin', 'editor'] })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await makeHandler().authenticate(ctx)

      expect(result.ticket!.principal.isInRole('admin')).toBe(true)
      expect(result.ticket!.principal.isInRole('editor')).toBe(true)
    })

    it('respects custom roleClaimType option', async () => {
      const handler = new JWTAuthenticationHandler('Bearer', {
        secret: SECRET,
        roleClaimType: 'role',
      })
      const token = await sign({ sub: 'u1', role: 'admin' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await handler.authenticate(ctx)

      expect(result.ticket!.principal.isInRole('admin')).toBe(true)
    })

    it('fires onTokenValidated with ctx and payload on success', async () => {
      const onTokenValidated = vi.fn()
      const handler = new JWTAuthenticationHandler('Bearer', { secret: SECRET, onTokenValidated })
      const token = await sign({ sub: 'user-hook' })
      const { ctx } = makeCtx(`Bearer ${token}`)

      await handler.authenticate(ctx)

      expect(onTokenValidated).toHaveBeenCalledOnce()

      const [passedCtx, payload] = onTokenValidated.mock.calls[0] as [unknown, Record<string, unknown>]
      expect(passedCtx).toBe(ctx)
      expect(payload.sub).toBe('user-hook')
    })

    it('does not fire onFail when header is absent', async () => {
      const onFail = vi.fn()
      const handler = new JWTAuthenticationHandler('Bearer', { secret: SECRET, onFail })
      const { ctx } = makeCtx(undefined)

      await handler.authenticate(ctx)

      expect(onFail).not.toHaveBeenCalled()
    })

    it('fires onFail with ctx and error on verification failure', async () => {
      const onFail = vi.fn()
      const handler = new JWTAuthenticationHandler('Bearer', { secret: SECRET, onFail })
      const { ctx } = makeCtx('Bearer not.a.jwt')

      await handler.authenticate(ctx)

      expect(onFail).toHaveBeenCalledOnce()

      const [passedCtx, err] = onFail.mock.calls[0] as [unknown, Error]
      expect(passedCtx).toBe(ctx)
      expect(err).toBeInstanceOf(Error)
    })

    it('uses custom claimMapper instead of default payload mapping', async () => {
      const claimMapper = vi.fn().mockReturnValue([])
      const handler = new JWTAuthenticationHandler('Bearer', { secret: SECRET, claimMapper })
      const token = await sign({ sub: 'u1' })
      const { ctx } = makeCtx(`Bearer ${token}`)
      const result = await handler.authenticate(ctx)

      expect(claimMapper).toHaveBeenCalledOnce()
      expect(result.succeeded).toBe(true)
    })
  })

  describe('challenge()', () => {
    it('sets status 401 and WWW-Authenticate: Bearer by default', async () => {
      const { ctx, status, header } = makeCtx()

      await makeHandler().challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer')
    })

    it('calls custom onChallenge and skips the default behaviour', async () => {
      const onChallenge = vi.fn()
      const handler = new JWTAuthenticationHandler('Bearer', { secret: SECRET, onChallenge })
      const { ctx, status } = makeCtx()

      await handler.challenge(ctx)

      expect(onChallenge).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('forbid()', () => {
    it('sets status 403 by default', async () => {
      const { ctx, status } = makeCtx()

      await makeHandler().forbid(ctx)

      expect(status).toHaveBeenCalledWith(403)
    })

    it('calls custom onForbid and skips the default behaviour', async () => {
      const onForbid = vi.fn()
      const handler = new JWTAuthenticationHandler('Bearer', { secret: SECRET, onForbid })
      const { ctx, status } = makeCtx()

      await handler.forbid(ctx)

      expect(onForbid).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })
})
