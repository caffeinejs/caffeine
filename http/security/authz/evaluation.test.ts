import { describe, expect, it, vi } from 'vitest'

import type { Context } from '../../context.js'
import { Claim, Identity, Principal } from '../identity.js'
import { AssertionHandler, AuthenticatedUserHandler, ClaimHandler, ResourceHandler, RoleHandler } from './handlers.js'
import { type AuthzRequirement, type AuthzRequirementHandler, newPolicyEvaluator } from './policy.js'
import { PolicyBuilder } from './policy_builder.js'
import { AuthzRouteService } from './route_service.js'

/**
 * How a policy is evaluated, as opposed to what it decides. Most requirements answer at once, so an evaluation is a
 * promise only from the first requirement that has to wait, and it stops at the first one that is not met either way.
 */

const ctx = {} as Context

const handlers = new Map(
  (
    [
      new AuthenticatedUserHandler(),
      new RoleHandler(),
      new ClaimHandler(),
      new AssertionHandler(),
      new ResourceHandler(),
    ] as unknown as Array<AuthzRequirementHandler<AuthzRequirement>>
  ).map(handler => [handler.kind, handler]),
)

const admin = new Principal(
  true,
  new Identity('Test', true, [new Claim('roles', 'admin', ''), new Claim('dept', 'eng', '')]),
)

function evaluator(build: (policy: PolicyBuilder) => unknown) {
  const builder = new PolicyBuilder()
  build(builder)

  return newPolicyEvaluator(builder.build('policy'), handlers)
}

describe('evaluating a policy', () => {
  it('answers at once when every requirement does', () => {
    const allowed = evaluator(p => p.requireAuthenticated().role('admin').claim('dept', 'eng'))(ctx, admin)
    const refused = evaluator(p => p.requireAuthenticated().role('auditor'))(ctx, admin)

    expect(allowed).toEqual({ ok: true })
    expect(refused).toMatchObject({ ok: false, failedPolicy: 'policy', failedRequirement: { kind: 'role' } })
  })

  it('waits for a requirement that has to ask, and goes on with the ones after it', async () => {
    const result = evaluator(p => p.assert(async () => true).role('auditor'))(ctx, admin)

    expect(result).toBeInstanceOf(Promise)
    expect(await result).toMatchObject({ ok: false, failedRequirement: { kind: 'role' } })
  })

  it('stops at the first requirement that is not met, before or after a wait', async () => {
    const never = vi.fn(async () => true)

    expect(evaluator(p => p.role('auditor').assert(never))(ctx, admin)).toMatchObject({ ok: false })
    expect(await evaluator(p => p.assert(async () => false).assert(never))(ctx, admin)).toMatchObject({
      ok: false,
      failedRequirement: { kind: 'assertion' },
    })
    expect(never).not.toHaveBeenCalled()
  })

  it('hands a requirement that throws to the caller as a rejection or a throw, never as an allow', async () => {
    const broken = evaluator(p =>
      p.assert(async () => {
        throw new Error('directory is down')
      }),
    )

    await expect(broken(ctx, admin)).rejects.toThrow('directory is down')
  })
})

describe('authorizing a route', () => {
  const allow = evaluator(p => p.requireAuthenticated())
  const refuse = evaluator(p => p.role('auditor'))
  const allowLater = evaluator(p => p.assert(async () => true))

  it('answers at once when every evaluator does', () => {
    expect(new AuthzRouteService([allow, allow]).authorize(ctx, admin)).toEqual({ ok: true })
    expect(new AuthzRouteService([allow, refuse]).authorize(ctx, admin)).toMatchObject({ ok: false })
    expect(new AuthzRouteService([]).authorize(ctx, admin)).toEqual({ ok: true })
  })

  it('requires every evaluator to allow, on both sides of a wait', async () => {
    expect(await new AuthzRouteService([allowLater, allow]).authorize(ctx, admin)).toEqual({ ok: true })
    expect(await new AuthzRouteService([allowLater, refuse]).authorize(ctx, admin)).toMatchObject({ ok: false })
    expect(await new AuthzRouteService([refuse, allowLater]).authorize(ctx, admin)).toMatchObject({ ok: false })
  })
})
