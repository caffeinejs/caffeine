import { Context } from '../../context.js'
import { Principal } from '../index.js'
import type { AssertionRequirement, AuthenticatedUserRequirement, ClaimRequirement, ResourceRequirement, RoleRequirement } from './policy_requirement.js'
import { AuthzPolicyResult, AuthzRequirementHandler } from './policy.js'

export class AuthenticatedUserHandler extends AuthzRequirementHandler<AuthenticatedUserRequirement> {
  get kind(): string {
    return 'authenticated'
  }

  async handle(ctx: Context, user: Principal): Promise<AuthzPolicyResult> {
    if (user.authenticated) {
      return { ok: true }
    }

    return { ok: false, reason: 'User is not authenticated' }
  }
}

/**
 * Satisfied when the user holds **any** of the listed roles.
 *
 * `RequireRole("Admin", "Manager")` reads as "an admin or a manager", which is both the natural reading
 * and what ASP.NET's `RolesAuthorizationRequirement` does — it returns on the first match. Requiring all
 * of them is still expressible, and more legibly: separate `role()` calls become separate requirements,
 * and a policy's requirements are ANDed. That is also how a controller-level `@Authorize` combines with a
 * method-level one, so the two levels keep tightening rather than widening each other.
 */
export class RoleHandler extends AuthzRequirementHandler<RoleRequirement> {
  get kind(): string {
    return 'role'
  }

  async handle(ctx: Context, user: Principal, requirement: RoleRequirement): Promise<AuthzPolicyResult> {
    if (requirement.roles.some(role => user.isInRole(role))) {
      return { ok: true }
    }

    return { ok: false, reason: 'User is in none of the required roles' }
  }
}

export class ClaimHandler extends AuthzRequirementHandler<ClaimRequirement> {
  get kind(): string {
    return 'claim'
  }

  async handle(ctx: Context, user: Principal, requirement: ClaimRequirement): Promise<AuthzPolicyResult> {
    if (requirement.claimValues.length === 0 && user.hasClaim(requirement.claim)) {
      return { ok: true }
    }

    if (requirement.claimValues.some(v => user.hasClaim(requirement.claim, v))) {
      return { ok: true }
    }

    return { ok: false, reason: 'User does not have the required claim or claim value' }
  }
}

export class AssertionHandler extends AuthzRequirementHandler<AssertionRequirement> {
  get kind(): string {
    return 'assertion'
  }

  async handle(ctx: Context, user: Principal, requirement: AssertionRequirement): Promise<AuthzPolicyResult> {
    const passed = await requirement.assertion(ctx)
    if (passed) {
      return { ok: true }
    }
    return { ok: false, reason: 'Assertion failed' }
  }
}

export class ResourceHandler extends AuthzRequirementHandler<ResourceRequirement> {
  get kind(): string {
    return 'resource'
  }

  async handle(
    ctx: Context, user: Principal, requirement: ResourceRequirement, resource?: unknown): Promise<AuthzPolicyResult> {
    const passed = await requirement.authorize(user, resource, ctx)
    if (passed) {
      return { ok: true }
    }
    return { ok: false, reason: 'Resource authorization failed' }
  }
}
