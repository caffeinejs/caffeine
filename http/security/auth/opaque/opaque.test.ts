import { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/std'
import { describe, it, expect, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { AuthenticationBuilder } from '../builder.js'
import { AuthenticateResult } from '../ticket.js'
import { OpaqueTokenAuthenticationHandler } from './opaque.js'
import { OpaqueTokenStore } from './opaque_token_store.js'

function makePrincipal(sub: string): Principal {
  return new Principal(true, new Identity('OpaqueToken', true, [new Claim('sub', sub, '')]))
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

function storeReturning(principal: Principal | null): OpaqueTokenStore {
  return { validate: vi.fn().mockResolvedValue(principal) }
}

function makeHandler(
  store: OpaqueTokenStore,
  options: Partial<Omit<ConstructorParameters<typeof OpaqueTokenAuthenticationHandler>[1], 'store'>> = {},
): OpaqueTokenAuthenticationHandler {
  const handler = new OpaqueTokenAuthenticationHandler('OpaqueToken', { store: OpaqueTokenStore, ...options })
  handler.setStore({ get: () => store })
  return handler
}

describe('OpaqueTokenAuthenticationHandler', () => {
  describe('authenticate()', () => {
    it('returns none when Authorization header is absent', async () => {
      const { ctx } = makeCtx(undefined)
      const result = await makeHandler(storeReturning(null)).authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns none when Authorization header does not start with "Bearer "', async () => {
      const { ctx } = makeCtx('Basic abc')
      const result = await makeHandler(storeReturning(makePrincipal('u1'))).authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('returns none when the token is empty', async () => {
      const store = storeReturning(makePrincipal('u1'))
      const { ctx } = makeCtx('Bearer    ')
      const result = await makeHandler(store).authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
      expect(store.validate).not.toHaveBeenCalled()
    })

    it('returns success with the principal the store resolves', async () => {
      const principal = makePrincipal('u1')
      const store = storeReturning(principal)
      const { ctx } = makeCtx('Bearer opaque-token')
      const result = await makeHandler(store).authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal).toBe(principal)
      expect(result.ticket!.scheme).toBe('OpaqueToken')
    })

    it('passes the raw token and ctx to the store', async () => {
      const store = storeReturning(makePrincipal('u1'))
      const { ctx } = makeCtx('Bearer the-token')
      await makeHandler(store).authenticate(ctx)

      expect(store.validate).toHaveBeenCalledWith('the-token', ctx)
    })

    it('returns fail and calls onFail when the store returns null (unknown/revoked/expired)', async () => {
      const onFail = vi.fn()
      const store = storeReturning(null)
      const { ctx } = makeCtx('Bearer revoked')
      const result = await makeHandler(store, { onFail }).authenticate(ctx)

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeInstanceOf(Error)
      expect(onFail).toHaveBeenCalledOnce()
    })

    it('returns fail and calls onFail when the store throws', async () => {
      const error = new Error('DB error')
      const onFail = vi.fn()
      const store: OpaqueTokenStore = { validate: vi.fn().mockRejectedValue(error) }
      const { ctx } = makeCtx('Bearer boom')
      const result = await makeHandler(store, { onFail }).authenticate(ctx)

      expect(result.error).toBe(error)
      expect(onFail).toHaveBeenCalledWith(ctx, error)
    })

    // A hook that throws used to be caught by the handler and called again, this time with its own error.
    it('calls onFail once when onFail itself throws, and lets its error out', async () => {
      const hookFailure = new Error('audit log is down')
      const onFail = vi.fn().mockRejectedValue(hookFailure)
      const { ctx } = makeCtx('Bearer unknown')

      const attempt = makeHandler(storeReturning(null), { onFail }).authenticate(ctx)

      await expect(attempt).rejects.toBe(hookFailure)
      expect(onFail).toHaveBeenCalledOnce()
      expect(onFail.mock.calls[0][1]).toMatchObject({ message: 'Invalid token' })
    })

    it('does not call onFail when the header is absent', async () => {
      const onFail = vi.fn()
      const { ctx } = makeCtx(undefined)
      await makeHandler(storeReturning(null), { onFail }).authenticate(ctx)

      expect(onFail).not.toHaveBeenCalled()
    })

    it('honours a custom scheme keyword', async () => {
      const principal = makePrincipal('u1')
      const store = storeReturning(principal)
      const { ctx } = makeCtx('Token xyz')
      const result = await makeHandler(store, { scheme: 'Token' }).authenticate(ctx)

      expect(result.succeeded).toBe(true)
      expect(store.validate).toHaveBeenCalledWith('xyz', ctx)
    })
  })

  describe('challenge()', () => {
    // RFC 6750 §3 makes the realm optional, and an empty one names nothing.
    it('sets status 401 and a bare WWW-Authenticate: Bearer when no realm is configured', async () => {
      const { ctx, status, header } = makeCtx()
      await makeHandler(storeReturning(null)).challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer')
    })

    // A client that reads `invalid_token` refreshes or signs in again; one that reads a bare challenge has no way
    // to tell its token was the problem.
    it('says the token is invalid when this request presented one that was refused', async () => {
      const { ctx, header } = makeCtx()
      const refused = AuthenticateResult.fail(new Error('Invalid token'))

      await makeHandler(storeReturning(null), { realm: 'api' }).challenge(ctx, undefined, refused)

      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="api", error="invalid_token"')
    })

    it('faults no token when none was presented', async () => {
      const { ctx, header } = makeCtx()

      await makeHandler(storeReturning(null), { realm: 'api' }).challenge(ctx, undefined, AuthenticateResult.none())

      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="api"')
    })

    // `error` is a parameter RFC 6750 registers for Bearer. Another keyword has none to say it with.
    it('invents no parameter for a keyword other than Bearer', async () => {
      const { ctx, header } = makeCtx()
      const refused = AuthenticateResult.fail(new Error('Invalid token'))

      await makeHandler(storeReturning(null), { scheme: 'Token' }).challenge(ctx, undefined, refused)

      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Token')
    })

    it('writes the realm as a quoted-string', async () => {
      const { ctx, header } = makeCtx()
      await makeHandler(storeReturning(null), { realm: 'The "API"' }).challenge(ctx)

      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="The \\"API\\""')
    })

    it('includes the configured realm and scheme', async () => {
      const { ctx, header } = makeCtx()
      await makeHandler(storeReturning(null), { scheme: 'Token', realm: 'My App' }).challenge(ctx)

      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Token realm="My App"')
    })

    it('delegates to onChallenge and skips default behaviour', async () => {
      const onChallenge = vi.fn()
      const { ctx, status } = makeCtx()
      await makeHandler(storeReturning(null), { onChallenge }).challenge(ctx)

      expect(onChallenge).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('forbid()', () => {
    it('sets status 403 by default', async () => {
      const { ctx, status } = makeCtx()
      await makeHandler(storeReturning(null)).forbid(ctx)

      expect(status).toHaveBeenCalledWith(403)
    })

    // RFC 6750 §3.1: the token was good, and it is not enough for this resource.
    it('says the token is not enough, under the Bearer keyword only', async () => {
      const bearer = makeCtx()
      await makeHandler(storeReturning(null), { realm: 'api' }).forbid(bearer.ctx)
      expect(bearer.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="api", error="insufficient_scope"')

      const custom = makeCtx()
      await makeHandler(storeReturning(null), { scheme: 'Token' }).forbid(custom.ctx)
      expect(custom.header).not.toHaveBeenCalled()
    })

    it('delegates to onForbid and skips default behaviour', async () => {
      const onForbid = vi.fn()
      const { ctx, status } = makeCtx()
      await makeHandler(storeReturning(null), { onForbid }).forbid(ctx)

      expect(onForbid).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('DI store resolution via configure()', () => {
    function makeKit(wrap: ReturnType<typeof vi.fn>): FeatureConfigureKit {
      const internal = vi.fn()
      const toValue = vi.fn().mockReturnValue({ internal })
      const bind = vi.fn().mockReturnValue({ toValue })
      return {
        container: { bind, wrap },
        config: {},
        store: {},
      } as unknown as FeatureConfigureKit
    }

    it('wraps the default OpaqueTokenStore token and injects the resolved store', async () => {
      const store = storeReturning(makePrincipal('u1'))
      const wrap = vi.fn().mockReturnValue({ get: () => store })
      const handler = new OpaqueTokenAuthenticationHandler('OpaqueToken', { store: OpaqueTokenStore })

      const builder = new AuthenticationBuilder()
      builder.addStrategy('OpaqueToken', handler)
      await builder[kFeatureConfigure](makeKit(wrap))

      expect(wrap).toHaveBeenCalledWith(OpaqueTokenStore)

      const { ctx } = makeCtx('Bearer tok')
      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(true)
    })

    it('injects an inline store instance without touching the container', async () => {
      const store = storeReturning(makePrincipal('u1'))
      const wrap = vi.fn()
      const handler = new OpaqueTokenAuthenticationHandler('OpaqueToken', { store })

      const builder = new AuthenticationBuilder()
      builder.addStrategy('OpaqueToken', handler)
      await builder[kFeatureConfigure](makeKit(wrap))

      expect(wrap).not.toHaveBeenCalled()

      const { ctx } = makeCtx('Bearer tok')
      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(true)
      expect(store.validate).toHaveBeenCalledWith('tok', ctx)
    })
  })
})
