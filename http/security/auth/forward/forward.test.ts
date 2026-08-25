import { describe, it, expect, vi } from 'vitest'
import type { Context } from '../../../context.js'
import { AuthenticateResult, type AuthenticationTicket } from '../ticket.js'
import { ErrAuthSchemeNotFound } from '../errors.js'
import { AuthenticationSchemeProvider } from '../scheme_provider.js'
import { ForwardAuthenticationHandler } from './forward.js'

const ctx = {} as unknown as Context

function makeDelegate() {
  return {
    authenticate: vi.fn().mockResolvedValue(AuthenticateResult.none()),
    challenge: vi.fn().mockResolvedValue(undefined),
    forbid: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
  }
}

function makeProvider(defaultScheme: string, handler?: ReturnType<typeof makeDelegate>) {
  return {
    defaultAuthenticateScheme: defaultScheme,
    schemeFor: vi.fn().mockReturnValue(handler != null ? { get: () => handler } : undefined),
    schemeNames: [defaultScheme],
  } as unknown as AuthenticationSchemeProvider
}

function setup(
  selector: (ctx: Context, scheme: string) => string | Promise<string>,
  defaultScheme = 'Bearer',
  handler = makeDelegate(),
) {
  const provider = makeProvider(defaultScheme, handler)
  const forward = new ForwardAuthenticationHandler(selector)

  forward.setSchemeProvider(provider)
  return { forward, provider, handler }
}

describe('ForwardAuthenticationHandler', () => {
  describe('authenticate()', () => {
    it('delegates to the resolved handler and returns its result', async () => {
      const result = AuthenticateResult.none()
      const handler = makeDelegate()
      handler.authenticate.mockResolvedValue(result)
      const { forward } = setup((_ctx, s) => s, 'Bearer', handler)

      expect(await forward.authenticate(ctx)).toBe(result)
      expect(handler.authenticate).toHaveBeenCalledWith(ctx)
    })
  })

  describe('challenge()', () => {
    it('delegates to the resolved handler, passing properties', async () => {
      const { forward, handler } = setup((_ctx, s) => s)
      const props = { items: { realm: 'test' } }

      await forward.challenge(ctx, props)

      expect(handler.challenge).toHaveBeenCalledWith(ctx, props)
    })
  })

  describe('forbid()', () => {
    it('delegates to the resolved handler, passing properties', async () => {
      const { forward, handler } = setup((_ctx, s) => s)
      const props = { items: { reason: 'access denied' } }

      await forward.forbid(ctx, props)

      expect(handler.forbid).toHaveBeenCalledWith(ctx, props)
    })
  })

  describe('persist()', () => {
    it('delegates to the resolved handler, passing the ticket', async () => {
      const { forward, handler } = setup((_ctx, s) => s)
      const ticket = {} as AuthenticationTicket

      await forward.persist(ctx, ticket)

      expect(handler.persist).toHaveBeenCalledWith(ctx, ticket)
    })
  })

  describe('revoke()', () => {
    it('delegates to the resolved handler, passing properties', async () => {
      const { forward, handler } = setup((_ctx, s) => s)
      const props = { items: { token: 'abc' } }

      await forward.revoke(ctx, props)

      expect(handler.revoke).toHaveBeenCalledWith(ctx, props)
    })
  })

  describe('scheme resolution', () => {
    it('passes ctx and defaultAuthenticateScheme to selector, then calls schemeFor with the returned scheme', async () => {
      const customHandler = makeDelegate()
      const selector = vi.fn().mockReturnValue('Custom')
      const provider = makeProvider('Bearer', customHandler)
      const forward = new ForwardAuthenticationHandler(selector)

      forward.setSchemeProvider(provider)

      await forward.authenticate(ctx)

      expect(selector).toHaveBeenCalledWith(ctx, 'Bearer')
      expect(provider.schemeFor).toHaveBeenCalledWith('Custom')
      expect(customHandler.authenticate).toHaveBeenCalledWith(ctx)
    })

    it('supports an async selector', async () => {
      const { forward } = setup(async (_ctx, s) => s)

      await expect(forward.authenticate(ctx)).resolves.toBeDefined()
    })

    it('throws when selector returns an empty string', async () => {
      const { forward } = setup(() => '')

      await expect(forward.authenticate(ctx)).rejects.toThrow(/selector returned no scheme/)
    })

    it('throws when no handler is registered for the selected scheme', async () => {
      const provider = makeProvider('Bearer', undefined)
      const forward = new ForwardAuthenticationHandler((_ctx, s) => s)

      forward.setSchemeProvider(provider)

      await expect(forward.authenticate(ctx)).rejects.toThrow(ErrAuthSchemeNotFound)
    })
  })
})
