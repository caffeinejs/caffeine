import { describe, it, expect, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { BasicAuthenticationHandler } from './basic.js'

function makePrincipal(username: string): Principal {
  const identity = new Identity('Basic', true, [new Claim('sub', username, '')])
  return new Principal(true, identity)
}

function makeCtx(authHeader?: string) {
  const status = vi.fn().mockReturnThis()
  // A challenge is appended: a route naming several schemes advertises each of them.
  const header = vi.fn().mockReturnThis()
  const ctx = {
    req: { header: (name: string) => (name === 'authorization' ? authHeader : undefined) },
    status,
    appendHeader: header,
  } as unknown as Context
  return { ctx, status, header }
}

function encode(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString('base64')
}

function makeHandler(validate = vi.fn().mockResolvedValue(null)) {
  return new BasicAuthenticationHandler('Basic', { validate })
}

describe('BasicAuthenticationHandler', () => {
  describe('authenticate()', () => {
    it('returns none when Authorization header is absent', async () => {
      const { ctx } = makeCtx(undefined)
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns none when Authorization header does not start with "Basic "', async () => {
      const { ctx } = makeCtx('Bearer sometoken')
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns fail when decoded credentials contain no colon', async () => {
      const encoded = Buffer.from('nocolon').toString('base64')
      const { ctx } = makeCtx(`Basic ${encoded}`)
      const result = await makeHandler().authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns fail when validate returns null', async () => {
      const { ctx } = makeCtx(`Basic ${encode('alice', 'wrong')}`)
      const result = await makeHandler(vi.fn().mockResolvedValue(null)).authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
    })

    it('returns success with the principal returned by validate', async () => {
      const principal = makePrincipal('alice')
      const validate = vi.fn().mockResolvedValue(principal)
      const { ctx } = makeCtx(`Basic ${encode('alice', 'secret')}`)
      const result = await new BasicAuthenticationHandler('Basic', { validate }).authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal).toBe(principal)
      expect(result.ticket!.scheme).toBe('Basic')
    })

    it('passes ctx, username, and password to validate', async () => {
      const validate = vi.fn().mockResolvedValue(makePrincipal('bob'))
      const { ctx } = makeCtx(`Basic ${encode('bob', 'p@ss:word')}`)
      await new BasicAuthenticationHandler('Basic', { validate }).authenticate(ctx)

      expect(validate).toHaveBeenCalledWith(ctx, 'bob', 'p@ss:word')
    })

    it('splits on first colon so passwords containing colons are handled correctly', async () => {
      const validate = vi.fn().mockResolvedValue(makePrincipal('u'))
      const { ctx } = makeCtx(`Basic ${encode('u', 'a:b:c')}`)
      await new BasicAuthenticationHandler('Basic', { validate }).authenticate(ctx)

      expect(validate).toHaveBeenCalledWith(ctx, 'u', 'a:b:c')
    })

    it('calls onFail and returns fail when validate returns null', async () => {
      const onFail = vi.fn()
      const { ctx } = makeCtx(`Basic ${encode('alice', 'bad')}`)
      const result = await new BasicAuthenticationHandler('Basic', {
        validate: vi.fn().mockResolvedValue(null),
        onFail,
      }).authenticate(ctx)

      expect(onFail).toHaveBeenCalledOnce()
      expect(result.succeeded).toBe(false)
    })

    it('calls onFail and returns fail when validate throws', async () => {
      const error = new Error('DB error')
      const onFail = vi.fn()
      const { ctx } = makeCtx(`Basic ${encode('alice', 'secret')}`)
      const result = await new BasicAuthenticationHandler('Basic', {
        validate: vi.fn().mockRejectedValue(error),
        onFail,
      }).authenticate(ctx)

      expect(onFail).toHaveBeenCalledWith(ctx, error)
      expect(result.error).toBe(error)
    })

    // A hook that throws used to be caught by the handler and called again, this time with its own error.
    it('calls onFail once when onFail itself throws, and lets its error out', async () => {
      const hookFailure = new Error('audit log is down')
      const onFail = vi.fn().mockRejectedValue(hookFailure)
      const { ctx } = makeCtx(`Basic ${encode('alice', 'bad')}`)

      const attempt = new BasicAuthenticationHandler('Basic', {
        validate: vi.fn().mockResolvedValue(null),
        onFail,
      }).authenticate(ctx)

      await expect(attempt).rejects.toBe(hookFailure)
      expect(onFail).toHaveBeenCalledOnce()
      expect(onFail.mock.calls[0][1]).toMatchObject({ message: 'Invalid credentials' })
    })

    it('does not call onFail when header is absent', async () => {
      const onFail = vi.fn()
      const { ctx } = makeCtx(undefined)
      await new BasicAuthenticationHandler('Basic', {
        validate: vi.fn(),
        onFail,
      }).authenticate(ctx)

      expect(onFail).not.toHaveBeenCalled()
    })
  })

  describe('challenge()', () => {
    it('sets status 401 and WWW-Authenticate: Basic with an empty realm by default', async () => {
      const { ctx, status, header } = makeCtx()
      await makeHandler().challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
      // RFC 7617 §2 requires the parameter, so an unset realm is sent empty rather than left out.
      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Basic realm="", charset="UTF-8"')
    })

    it('includes the configured realm in WWW-Authenticate', async () => {
      const { ctx, header } = makeCtx()
      await new BasicAuthenticationHandler('Basic', {
        validate: vi.fn(),
        realm: 'My App',
      }).challenge(ctx)

      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Basic realm="My App", charset="UTF-8"')
    })

    it('delegates to onChallenge and skips default behaviour', async () => {
      const onChallenge = vi.fn()
      const { ctx, status } = makeCtx()
      await new BasicAuthenticationHandler('Basic', { validate: vi.fn(), onChallenge }).challenge(ctx)

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

    it('delegates to onForbid and skips default behaviour', async () => {
      const onForbid = vi.fn()
      const { ctx, status } = makeCtx()
      await new BasicAuthenticationHandler('Basic', { validate: vi.fn(), onForbid }).forbid(ctx)

      expect(onForbid).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })
})
