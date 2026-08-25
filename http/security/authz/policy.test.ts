import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../../context.js'
import type { RouteAuthzOptions } from '../../decorators/registrar/routing.js'
import { Claim, Identity, Principal, newAnonymousUser } from '../identity.js'
import type { AuthorizationOptions } from './authz.js'
import {
  AssertionHandler,
  AuthenticatedUserHandler,
  ClaimHandler,
  ResourceHandler,
  RoleHandler,
} from './handlers.js'
import { type AuthzRequirement, type AuthzRequirementHandler, type PolicyEvaluator, compileRoutePolicy } from './policy.js'
import { PolicyBuilder } from './policy_builder.js'

/**
 * Unit tests for `compileRoutePolicy` — the function that turns the `@Authorize`/`@Roles`/`@AllowAnonymous`
 * decorators on a controller and a method into the guard that actually runs.
 *
 * It had no test of its own. Everything below was previously covered only incidentally, through end-to-end
 * suites that decorate a class and assert a status code, which cannot distinguish "the rule was applied" from
 * "the rule happened to produce the same status".
 */

const ctx = {} as Context

function handlers(): Map<string, AuthzRequirementHandler<AuthzRequirement>> {
  const list = [
    new AuthenticatedUserHandler(),
    new RoleHandler(),
    new ClaimHandler(),
    new AssertionHandler(),
    new ResourceHandler(),
  ] as unknown as Array<AuthzRequirementHandler<AuthzRequirement>>

  return new Map(list.map(h => [h.kind, h]))
}

function options(overrides: Partial<AuthorizationOptions> = {}): AuthorizationOptions {
  return {
    authorizeDecoratorDefaultPolicy: new PolicyBuilder().requireAuthenticated().build('default'),
    ...overrides,
  }
}

function user(claims: Array<[string, unknown]> = [], authenticated = true): Principal {
  return new Principal(authenticated, [
    new Identity('test', authenticated, claims.map(([type, value]) => new Claim(type, value, ''))),
  ])
}

function withRoles(...roles: string[]): Principal {
  return user([['roles', roles]])
}

/** Compiles and runs a route policy, returning the result. */
async function authorize(
  router: RouteAuthzOptions | undefined,
  route: RouteAuthzOptions | undefined,
  principal: Principal,
  opts: {
    policies?: Map<string, PolicyEvaluator>
    authorization?: AuthorizationOptions
    resource?: unknown
  } = {},
) {
  const service = compileRoutePolicy(
    opts.authorization ?? options(),
    opts.policies ?? new Map(),
    handlers(),
    router,
    route,
  )

  return { service, result: await service?.authorize(ctx, principal, opts.resource) }
}

describe('compileRoutePolicy — anonymous', () => {
  it('returns no guard when the route allows anonymous', async () => {
    const { service } = await authorize(undefined, { allowAnonymous: true }, newAnonymousUser())
    expect(service).toBeUndefined()
  })

  it('returns no guard when the controller allows anonymous', async () => {
    const { service } = await authorize({ allowAnonymous: true }, undefined, newAnonymousUser())
    expect(service).toBeUndefined()
  })

  // Precedence worth pinning: a controller-wide @AllowAnonymous wins over a method's @Authorize, so the
  // method is open. Surprising if you expect the more specific decorator to win, and nothing tested it.
  it('lets a controller-level allowAnonymous defeat a route-level requirement', async () => {
    const { service } = await authorize({ allowAnonymous: true }, { roles: ['admin'] }, newAnonymousUser())
    expect(service).toBeUndefined()
  })

  it('lets a route-level allowAnonymous defeat a controller-level requirement', async () => {
    const { service } = await authorize({ roles: ['admin'] }, { allowAnonymous: true }, newAnonymousUser())
    expect(service).toBeUndefined()
  })

  it('treats an explicit allowAnonymous: false as no opt-out', async () => {
    const { service, result } = await authorize(undefined, { allowAnonymous: false }, newAnonymousUser())

    expect(service).toBeDefined()
    expect(result?.ok).toBe(false)
  })
})

describe('compileRoutePolicy — the default policy', () => {
  it('applies the default policy when nothing else was declared', async () => {
    expect((await authorize(undefined, {}, user())).result?.ok).toBe(true)
    expect((await authorize(undefined, {}, newAnonymousUser())).result?.ok).toBe(false)
  })

  // `schemes` states no requirement of its own, so it must not suppress the default policy. This is the
  // regression that made @Authorize({ schemes }) admit anonymous callers.
  it('still applies the default policy when only schemes were named', async () => {
    expect((await authorize(undefined, { schemes: ['Basic'] }, newAnonymousUser())).result?.ok).toBe(false)
    expect((await authorize(undefined, { schemes: ['Basic'] }, user())).result?.ok).toBe(true)
  })

  it('applies an empty roles array as no requirement, falling back to the default policy', async () => {
    expect((await authorize(undefined, { roles: [] }, newAnonymousUser())).result?.ok).toBe(false)
  })

  // The existing suite set this to the same value as the built-in default, so the override path was never
  // actually exercised.
  it('honours a genuinely different authorizeDecoratorDefaultPolicy', async () => {
    const authorization = options({
      authorizeDecoratorDefaultPolicy: new PolicyBuilder().role('admin').build('admins-only'),
    })

    expect((await authorize(undefined, {}, withRoles('admin'), { authorization })).result?.ok).toBe(true)
    expect((await authorize(undefined, {}, withRoles('viewer'), { authorization })).result?.ok).toBe(false)
  })
})

describe('compileRoutePolicy — roles', () => {
  // One decorator naming several roles is an "any of these" gate, like `[Authorize(Roles = "a,b")]`.
  it('admits any of the roles named on a single decorator', async () => {
    expect((await authorize(undefined, { roles: ['a', 'b'] }, withRoles('a', 'b'))).result?.ok).toBe(true)
    expect((await authorize(undefined, { roles: ['a', 'b'] }, withRoles('a'))).result?.ok).toBe(true)
    expect((await authorize(undefined, { roles: ['a', 'b'] }, withRoles('c'))).result?.ok).toBe(false)
  })

  // Controller roles and method roles become two separate requirements, so they are ANDed. Nothing pinned
  // this, and "union" versus "intersection" is exactly the kind of thing that silently flips.
  it('requires the controller roles AND the route roles', async () => {
    const both = { router: { roles: ['staff'] }, route: { roles: ['admin'] } }

    expect((await authorize(both.router, both.route, withRoles('staff', 'admin'))).result?.ok).toBe(true)
    expect((await authorize(both.router, both.route, withRoles('staff'))).result?.ok).toBe(false)
    expect((await authorize(both.router, both.route, withRoles('admin'))).result?.ok).toBe(false)
  })

  it('reports which policy and requirement failed', async () => {
    const { result } = await authorize(undefined, { roles: ['admin'] }, withRoles('viewer'))

    expect(result?.ok).toBe(false)
    expect(result?.reason).toBe('User is in none of the required roles')
    expect(result?.failedRequirement).toMatchObject({ kind: 'role' })
  })
})

describe('compileRoutePolicy — named policies', () => {
  function policyMap(entries: Record<string, PolicyEvaluator>): Map<string, PolicyEvaluator> {
    return new Map(Object.entries(entries))
  }

  it('accepts a single policy name', async () => {
    const policies = policyMap({ admins: async (_c, u) => ({ ok: u.isInRole('admin') }) })

    expect((await authorize(undefined, { policy: 'admins' }, withRoles('admin'), { policies })).result?.ok).toBe(true)
    expect((await authorize(undefined, { policy: 'admins' }, withRoles('x'), { policies })).result?.ok).toBe(false)
  })

  it('accepts an array of policy names and requires all of them', async () => {
    const policies = policyMap({
      admins: async (_c, u) => ({ ok: u.isInRole('admin') }),
      staff: async (_c, u) => ({ ok: u.isInRole('staff') }),
    })
    const route = { policy: ['admins', 'staff'] }

    expect((await authorize(undefined, route, withRoles('admin', 'staff'), { policies })).result?.ok).toBe(true)
    expect((await authorize(undefined, route, withRoles('admin'), { policies })).result?.ok).toBe(false)
  })

  it('deduplicates a policy named on both the controller and the route', async () => {
    const evaluator = vi.fn(async () => ({ ok: true }))
    const policies = policyMap({ shared: evaluator })

    await authorize({ policy: 'shared' }, { policy: 'shared' }, user(), { policies })

    expect(evaluator).toHaveBeenCalledTimes(1)
  })

  it('combines a controller policy with route roles', async () => {
    const policies = policyMap({ staff: async (_c, u) => ({ ok: u.isInRole('staff') }) })
    const router = { policy: 'staff' }
    const route = { roles: ['admin'] }

    expect((await authorize(router, route, withRoles('staff', 'admin'), { policies })).result?.ok).toBe(true)
    expect((await authorize(router, route, withRoles('staff'), { policies })).result?.ok).toBe(false)
  })

  it('stops at the first failing policy and does not run the rest', async () => {
    const second = vi.fn(async () => ({ ok: true }))
    const policies = policyMap({
      // Alphabetical order is not guaranteed; what matters is that once one fails, evaluation halts.
      denies: async () => ({ ok: false, reason: 'nope' }),
      allows: second,
    })

    const { result } = await authorize(undefined, { policy: ['denies', 'allows'] }, user(), { policies })

    expect(result?.ok).toBe(false)
    expect(second).not.toHaveBeenCalled()
  })

  it('throws at compile time for an unknown policy name', () => {
    expect(() => compileRoutePolicy(options(), new Map(), handlers(), undefined, { policy: 'ghost' }))
      .toThrow(/no policy is registered under that name/)
  })

  it('throws at compile time for a requirement no handler covers', () => {
    const authorization = options({
      authorizeDecoratorDefaultPolicy: {
        name: 'weird',
        requirements: [{ kind: 'no-such-kind' }],
      },
    })

    expect(() => compileRoutePolicy(authorization, new Map(), handlers(), undefined, {}))
      .toThrow(/no handler is registered for requirement kind/)
  })
})
