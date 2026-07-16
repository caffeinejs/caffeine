import { describe, it, expect, vi } from 'vitest'
import type { Context } from '../../context.js'
import { Claim, Identity, Principal } from '../index.js'
import { AuthenticateResult, AuthenticationTicket } from './ticket.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationService } from './service.js'
import type { AuthenticationHandler } from './handler.js'

const ctx = {} as unknown as Context

function makeProvider(
  handlers: Record<string, AuthenticationHandler>,
  defaultScheme = '',
  challengeScheme?: string,
  forbidScheme?: string,
) {
  const schemes = new Map(
    Object.entries(handlers).map(([name, h]) => [name, { get: () => h }]),
  )
  return new AuthenticationSchemeProvider(schemes, {
    defaultAuthenticateScheme: defaultScheme,
    defaultChallengeScheme: challengeScheme,
    defaultForbidScheme: forbidScheme,
  })
}

function makePrincipal(sub = 'user'): Principal {
  return new Principal(true, new Identity('test', true, [new Claim('sub', sub, '')]))
}

function makeHandler(result: AuthenticateResult): AuthenticationHandler {
  return {
    authenticate: vi.fn().mockResolvedValue(result),
    challenge: vi.fn().mockResolvedValue(undefined),
    forbid: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
  }
}

describe('AuthenticationCoordinator', () => {
  describe('authenticate()', () => {
    it('returns none when scheme is not registered', async () => {
      const coordinator = new AuthenticationService(makeProvider({}))
      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.succeeded).toBe(false)
      expect(result.error).toBeUndefined()
    })

    it('passes ctx to the handler', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      await coordinator.authenticate(ctx, 'Bearer')

      expect(handler.authenticate).toHaveBeenCalledWith(ctx)
    })

    it('returns handler result unchanged when authentication fails', async () => {
      const err = new Error('bad token')
      const handler = makeHandler(AuthenticateResult.fail(err))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.succeeded).toBe(false)
      expect(result.error).toBe(err)
    })

    it('returns handler result unchanged when success and no mapper', async () => {
      const ticket = new AuthenticationTicket(makePrincipal(), 'Bearer')
      const handler = makeHandler(AuthenticateResult.success(ticket))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.succeeded).toBe(true)
      expect(result.ticket).toBe(ticket)
    })

    it('calls mapper and returns new ticket with mapped principal', async () => {
      const original = makePrincipal('original')
      const mapped = makePrincipal('mapped')
      const ticket = new AuthenticationTicket(original, 'Bearer')
      const handler = makeHandler(AuthenticateResult.success(ticket))
      const mapperFn = vi.fn().mockReturnValue(mapped)
      const coordinator = new AuthenticationService(
        makeProvider({ Bearer: handler }),
        { get: () => mapperFn },
      )

      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal).toBe(mapped)
      expect(mapperFn).toHaveBeenCalledWith(ctx, original)
    })

    it('preserves original ticket properties when mapper is applied', async () => {
      const props = {}
      const ticket = new AuthenticationTicket(makePrincipal(), 'Bearer', props)
      const handler = makeHandler(AuthenticateResult.success(ticket))
      const coordinator = new AuthenticationService(
        makeProvider({ Bearer: handler }),
        { get: () => vi.fn().mockReturnValue(makePrincipal('mapped')) },
      )

      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.ticket!.properties).toBe(props)
    })

    it('does not call mapper when authentication does not succeed', async () => {
      const mapperFn = vi.fn()
      const handler = makeHandler(AuthenticateResult.fail(new Error('expired')))
      const coordinator = new AuthenticationService(
        makeProvider({ Bearer: handler }),
        { get: () => mapperFn },
      )

      await coordinator.authenticate(ctx, 'Bearer')

      expect(mapperFn).not.toHaveBeenCalled()
    })
  })

  describe('challenge()', () => {
    it('delegates to handler with ctx and properties', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const props = {}
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.challenge(ctx, 'Bearer', props)

      expect(handler.challenge).toHaveBeenCalledWith(ctx, props)
    })

    it('uses default scheme when schemeName is not provided', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.challenge(ctx)

      expect(handler.challenge).toHaveBeenCalled()
    })

    it('uses defaultChallengeScheme over defaultAuthenticateScheme when set', async () => {
      const jwtHandler = makeHandler(AuthenticateResult.none())
      const basicHandler = makeHandler(AuthenticateResult.none())
      const coordinator = new AuthenticationService(
        makeProvider({ Bearer: jwtHandler, Basic: basicHandler }, 'Bearer', 'Basic'),
      )

      await coordinator.challenge(ctx)

      expect(basicHandler.challenge).toHaveBeenCalled()
      expect(jwtHandler.challenge).not.toHaveBeenCalled()
    })

    it('throws when scheme is not found', () => {
      const coordinator = new AuthenticationService(makeProvider({}, 'Bearer'))

      expect(() => coordinator.challenge(ctx, 'Bearer')).toThrow('Bearer')
    })
  })

  describe('forbid()', () => {
    it('delegates to handler with ctx and properties', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const props = {}
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.forbid(ctx, 'Bearer', props)

      expect(handler.forbid).toHaveBeenCalledWith(ctx, props)
    })

    it('uses default scheme when schemeName is not provided', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.forbid(ctx)

      expect(handler.forbid).toHaveBeenCalled()
    })

    it('uses defaultForbidScheme over defaultAuthenticateScheme when set', async () => {
      const jwtHandler = makeHandler(AuthenticateResult.none())
      const basicHandler = makeHandler(AuthenticateResult.none())
      const coordinator = new AuthenticationService(
        makeProvider({ Bearer: jwtHandler, Basic: basicHandler }, 'Bearer', undefined, 'Basic'),
      )

      await coordinator.forbid(ctx)

      expect(basicHandler.forbid).toHaveBeenCalled()
      expect(jwtHandler.forbid).not.toHaveBeenCalled()
    })

    it('throws when scheme is not found', () => {
      const coordinator = new AuthenticationService(makeProvider({}, 'Bearer'))

      expect(() => coordinator.forbid(ctx, 'Bearer')).toThrow('Bearer')
    })
  })

  describe('persist()', () => {
    it('delegates to handler with ctx and ticket', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const ticket = new AuthenticationTicket(makePrincipal(), 'Bearer')
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      await coordinator.persist(ctx, 'Bearer', ticket)

      expect(handler.persist).toHaveBeenCalledWith(ctx, ticket)
    })

    it('throws when scheme is not found', () => {
      const coordinator = new AuthenticationService(makeProvider({}))
      const ticket = new AuthenticationTicket(makePrincipal(), 'Bearer')

      expect(() => coordinator.persist(ctx, 'Bearer', ticket)).toThrow('Bearer')
    })
  })

  describe('revoke()', () => {
    it('delegates to handler with ctx and properties', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const props = {}
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      await coordinator.revoke(ctx, 'Bearer', props)

      expect(handler.revoke).toHaveBeenCalledWith(ctx, props)
    })

    it('throws when scheme is not found', () => {
      const coordinator = new AuthenticationService(makeProvider({}))

      expect(() => coordinator.revoke(ctx, 'Bearer')).toThrow('Bearer')
    })
  })
})
