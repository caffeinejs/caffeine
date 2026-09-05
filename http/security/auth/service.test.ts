import { beforeEach, describe, it, expect, vi } from 'vitest'

import type { Context } from '../../context.js'
import { Claim, Identity, Principal } from '../index.js'
import { ErrAuthSchemeNotFound } from './errors.js'
import type { AuthenticationHandler } from './handler.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationService } from './service.js'
import { AuthenticateResult, AuthenticationTicket } from './ticket.js'

// A fresh one per test: the per-request authentication record lives on the context now, so a context
// shared between tests would carry one test's memoised result into the next.
let ctx: Context

beforeEach(() => {
  ctx = {} as unknown as Context
})

function makeProvider(
  handlers: Record<string, AuthenticationHandler>,
  defaultScheme = '',
  challengeScheme?: string,
  forbidScheme?: string,
) {
  const schemes = new Map(Object.entries(handlers).map(([name, h]) => [name, { get: () => h }]))
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
    it('throws when the scheme is not registered, naming what is', async () => {
      // Not `none()`: that is the answer for "no credential was presented", and reusing it here made a
      // typo'd scheme name indistinguishable from an anonymous caller.
      const coordinator = new AuthenticationService(makeProvider({ Cookie: makeHandler(AuthenticateResult.none()) }))

      await expect(coordinator.authenticate(ctx, 'Beaerer')).rejects.toThrow(ErrAuthSchemeNotFound)
      await expect(coordinator.authenticate(ctx, 'Beaerer')).rejects.toThrow(/"Cookie"/)
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
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }), { get: () => mapperFn })

      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.succeeded).toBe(true)
      expect(result.ticket!.principal).toBe(mapped)
      expect(mapperFn).toHaveBeenCalledWith(ctx, original)
    })

    it('preserves original ticket properties when mapper is applied', async () => {
      const props = {}
      const ticket = new AuthenticationTicket(makePrincipal(), 'Bearer', props)
      const handler = makeHandler(AuthenticateResult.success(ticket))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }), {
        get: () => vi.fn().mockReturnValue(makePrincipal('mapped')),
      })

      const result = await coordinator.authenticate(ctx, 'Bearer')

      expect(result.ticket!.properties).toBe(props)
    })

    it('does not call mapper when authentication does not succeed', async () => {
      const mapperFn = vi.fn()
      const handler = makeHandler(AuthenticateResult.fail(new Error('expired')))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }), { get: () => mapperFn })

      await coordinator.authenticate(ctx, 'Bearer')

      expect(mapperFn).not.toHaveBeenCalled()
    })
  })

  describe('the per-request record', () => {
    it('runs a scheme once per request however many times it is asked', async () => {
      // A request authenticates repeatedly by design — the default scheme at the server hook, the named ones
      // at the route, and again from a handler holding this service. Running the scheme each time re-runs
      // whatever it does while reading the credential, and the cookie scheme spends a single-use token there.
      const handler = makeHandler(AuthenticateResult.success(new AuthenticationTicket(makePrincipal(), 'Bearer')))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      const first = coordinator.authenticate(ctx, 'Bearer')
      const second = coordinator.authenticate(ctx, 'Bearer')

      expect(second).toBe(first)
      await expect(second).resolves.toBe(await first)
      expect(handler.authenticate).toHaveBeenCalledTimes(1)
    })

    it('coalesces callers that ask while the scheme is still verifying', async () => {
      let release!: (result: AuthenticateResult) => void
      const handler = makeHandler(AuthenticateResult.none())
      handler.authenticate = vi.fn(() => new Promise<AuthenticateResult>(resolve => (release = resolve)))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      const both = Promise.all([coordinator.authenticate(ctx, 'Bearer'), coordinator.authenticate(ctx, 'Bearer')])
      release(AuthenticateResult.none())

      const [a, b] = await both
      expect(a).toBe(b)
      expect(handler.authenticate).toHaveBeenCalledTimes(1)
    })

    it('replays a rejection rather than re-running the scheme', async () => {
      // A scheme that blew up must blow up identically for everyone in the request: a second attempt could
      // disagree with the first because a key rotated or a session expired between them.
      const boom = new Error('jwks unreachable')
      const handler = makeHandler(AuthenticateResult.none())
      handler.authenticate = vi.fn().mockRejectedValue(boom)
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))

      await expect(coordinator.authenticate(ctx, 'Bearer')).rejects.toBe(boom)
      await expect(coordinator.authenticate(ctx, 'Bearer')).rejects.toBe(boom)
      expect(handler.authenticate).toHaveBeenCalledTimes(1)
    })

    it('keeps schemes apart within one request', async () => {
      const bearer = makeHandler(AuthenticateResult.success(new AuthenticationTicket(makePrincipal('a'), 'Bearer')))
      const cookie = makeHandler(AuthenticateResult.success(new AuthenticationTicket(makePrincipal('b'), 'Cookie')))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: bearer, Cookie: cookie }))

      const [first, second] = await Promise.all([
        coordinator.authenticate(ctx, 'Bearer'),
        coordinator.authenticate(ctx, 'Cookie'),
      ])

      expect(first.ticket!.principal.findFirst('sub')!.value).toBe('a')
      expect(second.ticket!.principal.findFirst('sub')!.value).toBe('b')
      expect(bearer.authenticate).toHaveBeenCalledTimes(1)
      expect(cookie.authenticate).toHaveBeenCalledTimes(1)
    })

    it('does not carry the result of one request into the next', async () => {
      const handler = makeHandler(AuthenticateResult.success(new AuthenticationTicket(makePrincipal(), 'Bearer')))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }))
      const other = {} as unknown as Context

      await coordinator.authenticate(ctx, 'Bearer')
      await coordinator.authenticate(other, 'Bearer')

      expect(handler.authenticate).toHaveBeenCalledTimes(2)
    })

    it('reads back the settled result without starting an authentication', async () => {
      // What a later phase of the request consults to decide how to answer a failure. It must never be the
      // thing that triggers the verification.
      const mapped = makePrincipal('mapped')
      const handler = makeHandler(AuthenticateResult.success(new AuthenticationTicket(makePrincipal(), 'Bearer')))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }), { get: () => () => mapped })

      expect(coordinator.resultFor(ctx, 'Bearer')).toBeUndefined()

      const pending = coordinator.authenticate(ctx, 'Bearer')
      expect(coordinator.resultFor(ctx, 'Bearer')).toBeUndefined()

      await pending

      expect(coordinator.resultFor(ctx, 'Bearer')!.ticket!.principal).toBe(mapped)
      expect(coordinator.resultFor(ctx, 'Basic')).toBeUndefined()
      expect(handler.authenticate).toHaveBeenCalledTimes(1)
    })
  })

  describe('challenge()', () => {
    it('delegates to handler with ctx and properties', async () => {
      const handler = makeHandler(AuthenticateResult.none())
      const props = {}
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.challenge(ctx, 'Bearer', props)

      expect(handler.challenge).toHaveBeenCalledWith(ctx, props, undefined)
    })

    it('hands the scheme what it already decided for this request', async () => {
      // How a scheme gets to say *why* it is challenging without keeping request state of its own, and
      // without re-authenticating to find out: the coordinator kept the result and gives it back.
      const failed = AuthenticateResult.fail(new Error('expired'))
      const handler = makeHandler(failed)
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.authenticate(ctx, 'Bearer')
      await coordinator.challenge(ctx, 'Bearer')

      expect(handler.challenge).toHaveBeenCalledWith(ctx, undefined, failed)
      expect(handler.authenticate).toHaveBeenCalledTimes(1)
    })

    it('challenges with nothing when the scheme has not run for this request', async () => {
      const handler = makeHandler(AuthenticateResult.fail(new Error('expired')))
      const coordinator = new AuthenticationService(makeProvider({ Bearer: handler }, 'Bearer'))

      await coordinator.challenge(ctx, 'Bearer')

      expect(handler.challenge).toHaveBeenCalledWith(ctx, undefined, undefined)
      expect(handler.authenticate).not.toHaveBeenCalled()
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
