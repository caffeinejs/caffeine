import { describe, it, expect, vi } from 'vitest'
import type { Container } from '@caffeinejs/di'
import { ApplicationAvailability, kServiceConfigure } from '@caffeinejs/std'
import type { Context } from '../../../context.js'
import type { Feats } from '../../../feats.js'
import type { ServiceKit } from '../../../service.js'
import { Claim, Identity, Principal } from '../../index.js'
import { AuthenticationBuilder } from '../builder.js'
import { OpaqueTokenAuthenticationHandler } from './opaque.js'
import { OpaqueTokenStore } from './opaque_token_store.js'

function makePrincipal(sub: string): Principal {
  return new Principal(true, new Identity('OpaqueToken', true, [new Claim('sub', sub, '')]))
}

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
    it('sets status 401 and WWW-Authenticate: Bearer realm="" by default', async () => {
      const { ctx, status, header } = makeCtx()
      await makeHandler(storeReturning(null)).challenge(ctx)

      expect(status).toHaveBeenCalledWith(401)
      expect(header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm=""')
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

    it('delegates to onForbid and skips default behaviour', async () => {
      const onForbid = vi.fn()
      const { ctx, status } = makeCtx()
      await makeHandler(storeReturning(null), { onForbid }).forbid(ctx)

      expect(onForbid).toHaveBeenCalledWith(ctx)
      expect(status).not.toHaveBeenCalled()
    })
  })

  describe('DI store resolution via [kServiceConfigure]', () => {
    function makeKit(wrap: ReturnType<typeof vi.fn>): ServiceKit {
      const internal = vi.fn()
      const toValue = vi.fn().mockReturnValue({ internal })
      const bind = vi.fn().mockReturnValue({ toValue })
      return {
        container: { bind, wrap } as unknown as Container,
        availability: new ApplicationAvailability(),
        feats: { toggleAuthentication: vi.fn().mockReturnThis() } as unknown as Feats,
      }
    }

    it('wraps the default OpaqueTokenStore token and injects the resolved store', async () => {
      const store = storeReturning(makePrincipal('u1'))
      const wrap = vi.fn().mockReturnValue({ get: () => store })
      const handler = new OpaqueTokenAuthenticationHandler('OpaqueToken', { store: OpaqueTokenStore })

      const builder = new AuthenticationBuilder().addStrategy('OpaqueToken', handler)
      await builder[kServiceConfigure](makeKit(wrap))

      expect(wrap).toHaveBeenCalledWith(OpaqueTokenStore)

      const { ctx } = makeCtx('Bearer tok')
      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(true)
    })

    it('injects an inline store instance without touching the container', async () => {
      const store = storeReturning(makePrincipal('u1'))
      const wrap = vi.fn()
      const handler = new OpaqueTokenAuthenticationHandler('OpaqueToken', { store })

      const builder = new AuthenticationBuilder().addStrategy('OpaqueToken', handler)
      await builder[kServiceConfigure](makeKit(wrap))

      expect(wrap).not.toHaveBeenCalled()

      const { ctx } = makeCtx('Bearer tok')
      const result = await handler.authenticate(ctx)
      expect(result.succeeded).toBe(true)
      expect(store.validate).toHaveBeenCalledWith('tok', ctx)
    })
  })
})
