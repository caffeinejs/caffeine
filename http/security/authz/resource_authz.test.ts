import { describe, it, expect, vi } from 'vitest'

import type { Context } from '../../context.js'
import { ErrHTTPForbidden } from '../../error/http.js'
import { Claim, Identity, Principal, newAnonymousUser } from '../index.js'
import { AuthenticatedUserHandler, ResourceHandler } from './handlers.js'
import { AuthzRequirement, AuthzRequirementHandler, PolicyEvaluator, newPolicyEvaluator } from './policy.js'
import { PolicyBuilder } from './policy_builder.js'
import { AuthorizationService } from './service.js'

interface Order {
  id: string
  ownerId: string
}

function makeUser(sub: string): Principal {
  return new Principal(true, new Identity('jwt', true, [new Claim('sub', sub, '')]))
}

function ctxFor(user: Principal): Context {
  return { user } as unknown as Context
}

function serviceWith(policyName: string, build: (b: PolicyBuilder) => void): AuthorizationService {
  const handlers = new Map<string, AuthzRequirementHandler<AuthzRequirement>>([
    ['authenticated', new AuthenticatedUserHandler()],
    ['resource', new ResourceHandler()],
  ])
  const b = new PolicyBuilder()
  build(b)
  const evaluators = new Map<string, PolicyEvaluator>([[policyName, newPolicyEvaluator(b.build(policyName), handlers)]])
  return new AuthorizationService(evaluators)
}

describe('resource-based authorization', () => {
  const order: Order = { id: 'o1', ownerId: 'u1' }
  const authz = serviceWith('CanEditOrder', b =>
    b.requireAuthenticated().resource((user, o: Order) => o.ownerId === user.findFirst('sub')?.value),
  )

  it('authorizes the owner (no throw)', async () => {
    await expect(authz.authorize(ctxFor(makeUser('u1')), 'CanEditOrder', order)).resolves.toBeUndefined()
    expect(await authz.allows(ctxFor(makeUser('u1')), 'CanEditOrder', order)).toBe(true)
    expect(await authz.denies(ctxFor(makeUser('u1')), 'CanEditOrder', order)).toBe(false)
  })

  // The message is what the client reads, so it says nothing about how the rules are laid out. The policy that
  // refused and its reason are kept for whoever reads the log.
  it('throws ErrHTTPForbidden for a non-owner, keeping the policy and the reason off the message', async () => {
    const error = await authz.authorize(ctxFor(makeUser('someone-else')), 'CanEditOrder', order).catch(e => e)

    expect(error).toBeInstanceOf(ErrHTTPForbidden)
    expect(error.message).toBe('Forbidden')
    expect(String(error.cause.message)).toMatch(/CanEditOrder.*Resource authorization failed/)
    expect(await authz.allows(ctxFor(makeUser('someone-else')), 'CanEditOrder', order)).toBe(false)
  })

  it('fails the authenticated requirement first for an anonymous user', async () => {
    const error = await authz.authorize(ctxFor(newAnonymousUser()), 'CanEditOrder', order).catch(e => e)

    expect(error).toBeInstanceOf(ErrHTTPForbidden)
    expect(String(error.cause.message)).toMatch(/CanEditOrder.*not authenticated/)
  })

  it('passes the loaded resource through to the requirement', async () => {
    const check = vi.fn().mockReturnValue(true)
    const svc = serviceWith('WithSpy', b => b.resource(check))
    await svc.authorize(ctxFor(makeUser('u1')), 'WithSpy', order)

    expect(check).toHaveBeenCalledOnce()
    expect(check.mock.calls[0][1]).toBe(order)
  })

  it('throws when the policy is unknown', async () => {
    await expect(authz.authorize(ctxFor(makeUser('u1')), 'Nope', order)).rejects.toThrow(
      /no policy is registered under that name/,
    )
  })
})
