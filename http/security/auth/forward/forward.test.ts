import { beforeEach, describe, it, expect, vi } from 'vitest'

import type { Context } from '../../../context.js'
import { Identity, Principal } from '../../index.js'
import { ErrAuthSchemeNotFound } from '../errors.js'
import { AuthenticationSchemeProvider } from '../scheme_provider.js'
import { AuthenticationService } from '../service.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'
import { ForwardAuthenticationHandler } from './forward.js'

// One per test: what a scheme decided is remembered on the request.
let ctx: Context

beforeEach(() => {
  ctx = {} as unknown as Context
})

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
  const forward = wired(new ForwardAuthenticationHandler(selector), provider)

  return { forward, provider, handler }
}

/** Wires a forwarding scheme the way the authentication builder does. */
function wired(forward: ForwardAuthenticationHandler, provider: AuthenticationSchemeProvider) {
  forward.setSchemeProvider(provider)
  forward.setService(new AuthenticationService(provider))

  return forward
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
    it('delegates to the resolved handler, passing properties and the earlier result', async () => {
      // The delegate is the scheme that produced the result, so it is the one that can name the reason it
      // rejected the credential. Forwarding stops that at the door if it drops the argument.
      const { forward, handler } = setup((_ctx, s) => s)
      const props = { redirectURI: '/after-challenge' }
      const previous = AuthenticateResult.fail(new Error('expired'))

      await forward.challenge(ctx, props, previous)

      expect(handler.challenge).toHaveBeenCalledWith(ctx, props, previous)
    })
  })

  describe('forbid()', () => {
    it('delegates to the resolved handler, passing properties', async () => {
      const { forward, handler } = setup((_ctx, s) => s)
      const props = { redirectURI: '/after-forbid' }

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
      const props = { redirectURI: '/after-revoke' }

      await forward.revoke(ctx, props)

      expect(handler.revoke).toHaveBeenCalledWith(ctx, props)
    })
  })

  describe('scheme resolution', () => {
    it('passes ctx and defaultAuthenticateScheme to selector, then calls schemeFor with the returned scheme', async () => {
      const customHandler = makeDelegate()
      const selector = vi.fn().mockReturnValue('Custom')
      const provider = makeProvider('Bearer', customHandler)
      const forward = wired(new ForwardAuthenticationHandler(selector), provider)

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
      const forward = wired(new ForwardAuthenticationHandler((_ctx, s) => s), provider)

      await expect(forward.authenticate(ctx)).rejects.toThrow(ErrAuthSchemeNotFound)
    })
  })

  // Reading a credential can spend it — a remember-me token rotates when it is read — so the scheme that was
  // picked runs once for a request, however the request reaches it.
  describe('the scheme it picked, within one request', () => {
    function application(mapper?: (ctx: Context, principal: Principal) => Principal) {
      const target = makeDelegate()
      target.authenticate.mockImplementation(async () =>
        AuthenticateResult.success(
          new AuthenticationTicket(new Principal(true, new Identity('Cookie', true)), 'Cookie'),
        ),
      )

      const forward = new ForwardAuthenticationHandler(() => 'Cookie')
      const handlers: Record<string, unknown> = { Forward: forward, Cookie: target }
      const provider = {
        defaultAuthenticateScheme: 'Forward',
        schemeFor: (name: string) => (name in handlers ? { get: () => handlers[name] } : undefined),
        schemeNames: Object.keys(handlers),
      } as unknown as AuthenticationSchemeProvider
      const service = new AuthenticationService(provider, mapper === undefined ? undefined : { get: () => mapper })

      forward.setSchemeProvider(provider)
      forward.setService(service)

      return { service, target }
    }

    it('runs once whether it is reached through the forward, by name, or both', async () => {
      const { service, target } = application()

      const viaForward = await service.authenticate(ctx, 'Forward')
      const byName = await service.authenticate(ctx, 'Cookie')

      expect(target.authenticate).toHaveBeenCalledOnce()
      expect(byName).toBe(viaForward)
    })

    it('runs once when both reach it at the same moment', async () => {
      const { service, target } = application()

      await Promise.all([service.authenticate(ctx, 'Cookie'), service.authenticate(ctx, 'Forward')])

      expect(target.authenticate).toHaveBeenCalledOnce()
    })

    // The forward hands back what the scheme it picked decided, which has been through the mapper once already.
    it('maps the principal once', async () => {
      const mapper = vi.fn((_ctx: Context, principal: Principal) => principal)
      const { service } = application(mapper)

      await service.authenticate(ctx, 'Forward')

      expect(mapper).toHaveBeenCalledOnce()
    })

    it('remembers what was decided under both names, so a challenge can say why', async () => {
      const { service } = application()

      await service.authenticate(ctx, 'Forward')

      expect(service.resultFor(ctx, 'Forward')).toBe(service.resultFor(ctx, 'Cookie'))
      expect(service.resultFor(ctx, 'Forward')?.ticket?.scheme).toBe('Cookie')
    })
  })

  // A selector often reads the request: a header, a query parameter naming the provider. One that can be talked
  // into naming a forwarding scheme would wait on its own answer, and the request with it, for ever.
  describe('a selector that names a forwarding scheme', () => {
    function loop(selected: string) {
      const first = new ForwardAuthenticationHandler(() => selected)
      const second = new ForwardAuthenticationHandler(() => 'First')
      const handlers: Record<string, unknown> = { First: first, Second: second }
      const provider = {
        defaultAuthenticateScheme: 'First',
        schemeFor: (name: string) => (name in handlers ? { get: () => handlers[name] } : undefined),
        schemeNames: Object.keys(handlers),
      } as unknown as AuthenticationSchemeProvider
      const service = new AuthenticationService(provider)

      for (const forward of [first, second]) {
        forward.setSchemeProvider(provider)
        forward.setService(service)
      }

      return { service, first }
    }

    it('is refused when it names itself', async () => {
      const { service } = loop('First')

      await expect(service.authenticate(ctx, 'First')).rejects.toMatchObject({
        code: 'ERR_AUTH_CONFIGURATION',
        message: expect.stringContaining('"First", which forwards as well'),
      })
    })

    it('is refused when it names another that would send it back', async () => {
      const { service } = loop('Second')

      await expect(service.authenticate(ctx, 'First')).rejects.toThrow(/"Second", which forwards as well/)
    })

    it('is refused on the way to a challenge too', async () => {
      const { first } = loop('First')

      await expect(first.challenge(ctx)).rejects.toThrow(/forwards as well/)
    })
  })
})
