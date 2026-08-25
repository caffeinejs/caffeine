import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../../context.js'
import { Claim, Identity, Principal, newAnonymousUser } from '../identity.js'
import {
  AssertionHandler,
  AuthenticatedUserHandler,
  ClaimHandler,
  ResourceHandler,
  RoleHandler,
} from './handlers.js'
import type {
  AssertionRequirement,
  ClaimRequirement,
  ResourceRequirement,
  RoleRequirement,
} from './policy_requirement.js'

/**
 * The requirement handlers, one branch at a time.
 *
 * `AssertionHandler` had no coverage at all — `PolicyBuilder.assert()` is not called anywhere in the suite —
 * and `ClaimHandler`'s deny, presence-only and multi-value branches were equally untouched.
 */

const ctx = {} as Context

function user(claims: Array<[string, unknown]>, roleClaimType = 'roles'): Principal {
  return new Principal(true, [
    new Identity('test', true, claims.map(([type, value]) => new Claim(type, value, '')), roleClaimType),
  ])
}

describe('AuthenticatedUserHandler', () => {
  const handler = new AuthenticatedUserHandler()

  it('passes an authenticated principal', async () => {
    expect(await handler.handle(ctx, user([]))).toEqual({ ok: true })
  })

  it('fails an anonymous principal with a reason', async () => {
    expect(await handler.handle(ctx, newAnonymousUser()))
      .toEqual({ ok: false, reason: 'User is not authenticated' })
  })
})

describe('RoleHandler', () => {
  const handler = new RoleHandler()
  const requirement = (...roles: string[]) => ({ kind: 'role', roles }) as RoleRequirement

  it('passes when the single required role is held', async () => {
    expect((await handler.handle(ctx, user([['roles', 'admin']]), requirement('admin'))).ok).toBe(true)
  })

  // `.every`, not `.some` — every named role is required. The distinction is the difference between an
  // authorization rule and a much weaker one, and it was never exercised with more than one role.
  // ASP.NET's RolesAuthorizationRequirement returns on the first role that matches, and
  // `[Authorize(Roles = "Admin,Manager")]` reads as "admin or manager". Requiring both is expressed as
  // two requirements, which the policy evaluator ANDs — see the PolicyBuilder test below.
  it('requires ANY of the roles named on one requirement', async () => {
    const both = user([['roles', ['admin', 'staff']]])
    const one = user([['roles', ['admin']]])
    const neither = user([['roles', ['viewer']]])

    expect((await handler.handle(ctx, both, requirement('admin', 'staff'))).ok).toBe(true)
    expect((await handler.handle(ctx, one, requirement('admin', 'staff'))).ok).toBe(true)
    expect((await handler.handle(ctx, neither, requirement('admin', 'staff'))).ok).toBe(false)
  })

  it('reads a role claim whose value is an array', async () => {
    expect((await handler.handle(ctx, user([['roles', ['a', 'b']]]), requirement('b'))).ok).toBe(true)
  })

  it('honours a custom roleClaimType', async () => {
    const principal = user([['scope', 'admin']], 'scope')

    expect((await handler.handle(ctx, principal, requirement('admin'))).ok).toBe(true)
  })

  it('fails with a reason', async () => {
    expect(await handler.handle(ctx, user([['roles', 'viewer']]), requirement('admin')))
      .toEqual({ ok: false, reason: 'User is in none of the required roles' })
  })
})

describe('ClaimHandler', () => {
  const handler = new ClaimHandler()
  const requirement = (claim: string, ...claimValues: unknown[]) =>
    ({ kind: 'claim', claim, claimValues }) as ClaimRequirement

  it('passes on mere presence when no values are required', async () => {
    expect((await handler.handle(ctx, user([['email', 'a@b.c']]), requirement('email'))).ok).toBe(true)
  })

  it('fails on absence when no values are required', async () => {
    expect((await handler.handle(ctx, user([]), requirement('email'))).ok).toBe(false)
  })

  it('passes when any one of several accepted values matches', async () => {
    const principal = user([['plan', 'pro']])

    expect((await handler.handle(ctx, principal, requirement('plan', 'free', 'pro'))).ok).toBe(true)
  })

  it('fails when the claim exists but holds none of the accepted values', async () => {
    const principal = user([['plan', 'trial']])

    expect(await handler.handle(ctx, principal, requirement('plan', 'free', 'pro')))
      .toEqual({ ok: false, reason: 'User does not have the required claim or claim value' })
  })
})

describe('AssertionHandler', () => {
  const handler = new AssertionHandler()
  const requirement = (assertion: AssertionRequirement['assertion']) =>
    ({ kind: 'assertion', assertion }) as AssertionRequirement

  it('passes when a synchronous predicate returns true', async () => {
    expect((await handler.handle(ctx, user([]), requirement(() => true))).ok).toBe(true)
  })

  it('fails with a reason when the predicate returns false', async () => {
    expect(await handler.handle(ctx, user([]), requirement(() => false)))
      .toEqual({ ok: false, reason: 'Assertion failed' })
  })

  it('awaits an asynchronous predicate', async () => {
    expect((await handler.handle(ctx, user([]), requirement(async () => true))).ok).toBe(true)
    expect((await handler.handle(ctx, user([]), requirement(async () => false))).ok).toBe(false)
  })

  it('receives the request context', async () => {
    const assertion = vi.fn(() => true)

    await handler.handle(ctx, user([]), requirement(assertion))

    expect(assertion).toHaveBeenCalledWith(ctx)
  })

  // A throwing predicate propagates rather than being swallowed into a denial. Worth pinning either way:
  // silently treating a crash as "denied" would hide bugs behind a 403.
  it('propagates a throwing predicate', async () => {
    const boom = () => {
      throw new Error('boom')
    }

    await expect(handler.handle(ctx, user([]), requirement(boom))).rejects.toThrow('boom')
  })
})

describe('ResourceHandler', () => {
  const handler = new ResourceHandler()
  const requirement = (authorize: ResourceRequirement['authorize']) =>
    ({ kind: 'resource', authorize }) as ResourceRequirement

  it('passes the principal, the resource and the context to the callback', async () => {
    const authorize = vi.fn(() => true)
    const principal = user([['sub', 'u1']])
    const resource = { ownerId: 'u1' }

    await handler.handle(ctx, principal, requirement(authorize), resource)

    expect(authorize).toHaveBeenCalledWith(principal, resource, ctx)
  })

  it('fails with a reason when the callback denies', async () => {
    expect(await handler.handle(ctx, user([]), requirement(() => false), {}))
      .toEqual({ ok: false, reason: 'Resource authorization failed' })
  })

  it('awaits an asynchronous callback', async () => {
    expect((await handler.handle(ctx, user([]), requirement(async () => true), {})).ok).toBe(true)
  })

  // A route guard never supplies a resource, so a resource requirement in a route policy sees `undefined`.
  // The callback is what decides; the handler must not crash before reaching it.
  it('passes undefined through when no resource was supplied', async () => {
    const authorize = vi.fn((_u: Principal, resource: unknown) => resource === undefined)

    expect((await handler.handle(ctx, user([]), requirement(authorize))).ok).toBe(true)
  })
})
