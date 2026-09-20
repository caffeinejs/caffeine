import { describe, expect, it, vi } from 'vitest'

import type { Context } from '../../context.js'
import { foldAuthz, mergeAuthz } from '../../routing/inherit.js'
import type { RouteAuthz, RouteAuthzOptions } from '../../routing/spec.js'
import { Claim, Identity, Principal, anonymousUser } from '../identity.js'
import type { AuthorizationOptions } from './authz.js'
import { AssertionHandler, AuthenticatedUserHandler, ClaimHandler, ResourceHandler, RoleHandler } from './handlers.js'
import {
  type AuthzRequirement,
  type AuthzRequirementHandler,
  type PolicyEvaluator,
  compileRoutePolicy,
} from './policy.js'
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
    new Identity(
      'test',
      authenticated,
      claims.map(([type, value]) => new Claim(type, value, '')),
    ),
  ])
}

function withRoles(...roles: string[]): Principal {
  return user([['roles', roles]])
}

/** What one level declared: nothing, one declaration, or several stacked on it. */
type Level = RouteAuthzOptions | RouteAuthzOptions[] | undefined

function declared(level: Level): RouteAuthz | undefined {
  if (level === undefined) {
    return undefined
  }

  return (Array.isArray(level) ? level : [level]).reduce<RouteAuthz | undefined>(foldAuthz, undefined)
}

/** Everything declared from the outermost group down to the route, the way the router compiler combines it. */
function effective(...levels: Level[]): RouteAuthz | undefined {
  return levels.map(declared).reduce(mergeAuthz, undefined)
}

/** Compiles and runs a route policy, returning the result. */
async function authorize(
  router: Level,
  route: Level,
  principal: Principal,
  opts: {
    policies?: Map<string, PolicyEvaluator>
    authorization?: AuthorizationOptions
    resource?: unknown
    /** Groups the router itself is nested in, outermost first. */
    outer?: Level[]
  } = {},
) {
  const service = compileRoutePolicy(
    opts.authorization ?? options(),
    opts.policies ?? new Map(),
    handlers(),
    effective(...(opts.outer ?? []), router, route),
  )

  return { service, result: await service?.authorize(ctx, principal, opts.resource) }
}

describe('compileRoutePolicy — anonymous', () => {
  it('returns no guard when the route allows anonymous', async () => {
    const { service } = await authorize(undefined, { allowAnonymous: true }, anonymousUser())
    expect(service).toBeUndefined()
  })

  it('returns no guard when the controller allows anonymous', async () => {
    const { service } = await authorize({ allowAnonymous: true }, undefined, anonymousUser())
    expect(service).toBeUndefined()
  })

  // The more specific declaration wins. A public controller opens the methods that declare nothing; a method
  // that asks for protection gets it, or writing `@Roles` on it would be a rule that enforces nothing.
  it('keeps a route-level requirement under a controller-level allowAnonymous', async () => {
    const router = { allowAnonymous: true }

    expect((await authorize(router, { roles: ['admin'] }, anonymousUser())).result?.ok).toBe(false)
    expect((await authorize(router, { roles: ['admin'] }, withRoles('viewer'))).result?.ok).toBe(false)
    expect((await authorize(router, { roles: ['admin'] }, withRoles('admin'))).result?.ok).toBe(true)
    expect((await authorize(router, {}, anonymousUser())).result?.ok).toBe(false)
  })

  it('opens a route that declares nothing under a controller-level allowAnonymous', async () => {
    const { service } = await authorize({ allowAnonymous: true }, undefined, anonymousUser())
    expect(service).toBeUndefined()
  })

  it('lets allowAnonymous win over a requirement declared on the same level', async () => {
    const { service } = await authorize(undefined, [{ roles: ['admin'] }, { allowAnonymous: true }], anonymousUser())
    expect(service).toBeUndefined()
  })

  // A group declared public inside a protected one opens what is below it. A route below that asks for
  // protection again is protected by everything declared above it, the outermost group's roles included.
  it('re-protects below a public group with every requirement declared above it', async () => {
    const outer = [{ roles: ['admin'] }]
    const publicGroup = { allowAnonymous: true }

    expect((await authorize(publicGroup, undefined, anonymousUser(), { outer })).service).toBeUndefined()
    expect((await authorize(publicGroup, {}, withRoles('viewer'), { outer })).result?.ok).toBe(false)
    expect((await authorize(publicGroup, {}, withRoles('admin'), { outer })).result?.ok).toBe(true)
  })

  it('lets a route-level allowAnonymous defeat a controller-level requirement', async () => {
    const { service } = await authorize({ roles: ['admin'] }, { allowAnonymous: true }, anonymousUser())
    expect(service).toBeUndefined()
  })

  it('treats an explicit allowAnonymous: false as no opt-out', async () => {
    const { service, result } = await authorize(undefined, { allowAnonymous: false }, anonymousUser())

    expect(service).toBeDefined()
    expect(result?.ok).toBe(false)
  })
})

describe('compileRoutePolicy — the default policy', () => {
  it('applies the default policy when nothing else was declared', async () => {
    expect((await authorize(undefined, {}, user())).result?.ok).toBe(true)
    expect((await authorize(undefined, {}, anonymousUser())).result?.ok).toBe(false)
  })

  // `schemes` states no requirement of its own, so it must not suppress the default policy. This is the
  // regression that made @Authorize({ schemes }) admit anonymous callers.
  it('still applies the default policy when only schemes were named', async () => {
    expect((await authorize(undefined, { schemes: ['Basic'] }, anonymousUser())).result?.ok).toBe(false)
    expect((await authorize(undefined, { schemes: ['Basic'] }, user())).result?.ok).toBe(true)
  })

  it('applies an empty roles array as no requirement, falling back to the default policy', async () => {
    expect((await authorize(undefined, { roles: [] }, anonymousUser())).result?.ok).toBe(false)
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

  // Two declarations on one level used to be one assignment after another: the last decorator applied won and
  // the other vanished, whichever it was.
  it('requires every roles declaration stacked on one level', async () => {
    const route = [{ roles: ['staff'] }, { roles: ['admin'] }]

    expect((await authorize(undefined, route, withRoles('staff', 'admin'))).result?.ok).toBe(true)
    expect((await authorize(undefined, route, withRoles('staff'))).result?.ok).toBe(false)
    expect((await authorize(undefined, route, withRoles('admin'))).result?.ok).toBe(false)
  })

  // A nested group used to merge its roles into its parent's list, so either set would do and the child
  // widened what the parent restricted.
  it('requires the roles of every group a route is nested in', async () => {
    const outer = [{ roles: ['admin'] }]
    const router = { roles: ['auditor'] }

    expect((await authorize(router, undefined, withRoles('admin', 'auditor'), { outer })).result?.ok).toBe(true)
    expect((await authorize(router, undefined, withRoles('auditor'), { outer })).result?.ok).toBe(false)
    expect((await authorize(router, undefined, withRoles('admin'), { outer })).result?.ok).toBe(false)
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

  it.each([
    ['roles declared before the policy', [{ roles: ['admin'] }, { policy: 'staff' }]],
    ['the policy declared before the roles', [{ policy: 'staff' }, { roles: ['admin'] }]],
  ])('requires both when a policy and roles are stacked on one level: %s', async (_label, route) => {
    const policies = policyMap({ staff: async (_c, u) => ({ ok: u.isInRole('staff') }) })

    expect((await authorize(undefined, route, withRoles('staff', 'admin'), { policies })).result?.ok).toBe(true)
    expect((await authorize(undefined, route, withRoles('staff'), { policies })).result?.ok).toBe(false)
    expect((await authorize(undefined, route, withRoles('admin'), { policies })).result?.ok).toBe(false)
    expect((await authorize(undefined, route, anonymousUser(), { policies })).result?.ok).toBe(false)
  })

  // A bare @Authorize on the controller says "signed-in users only". A method naming a policy adds to that;
  // it used to replace it, so a policy that asks nothing about the caller admitted anonymous ones.
  it('keeps the default policy of a bare controller declaration when the route names a policy', async () => {
    const policies = policyMap({ open: async () => ({ ok: true }) })

    expect((await authorize({}, { policy: 'open' }, anonymousUser(), { policies })).result?.ok).toBe(false)
    expect((await authorize({}, { policy: 'open' }, user(), { policies })).result?.ok).toBe(true)
    // Without the bare declaration the policy stands alone, and it asks for no identity.
    expect((await authorize(undefined, { policy: 'open' }, anonymousUser(), { policies })).result?.ok).toBe(true)
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
    expect(() => compileRoutePolicy(options(), new Map(), handlers(), declared({ policy: 'ghost' }))).toThrow(
      /no policy is registered under that name/,
    )
  })

  it('throws at compile time for a requirement no handler covers', () => {
    const authorization = options({
      authorizeDecoratorDefaultPolicy: {
        name: 'weird',
        requirements: [{ kind: 'no-such-kind' }],
      },
    })

    expect(() => compileRoutePolicy(authorization, new Map(), handlers(), declared({}))).toThrow(
      /no handler is registered for requirement kind/,
    )
  })
})

describe('compileRoutePolicy — a declaration assembled by hand', () => {
  // A route source may build the declaration itself. One that is protected and asks for nothing must not
  // compile to a guard that runs nothing.
  it('fails closed on a protected declaration with no requirement in it', async () => {
    const empty: RouteAuthz = { allowAnonymous: false, defaultPolicy: false, policies: [], roleGroups: [] }
    const service = compileRoutePolicy(options(), new Map(), handlers(), empty)

    expect((await service?.authorize(ctx, anonymousUser()))?.ok).toBe(false)
    expect((await service?.authorize(ctx, user()))?.ok).toBe(true)
  })
})
