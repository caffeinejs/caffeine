import { Context } from '../../context.js'
import { Principal } from '../principal.js'
import type { RequireAssertion, RequireAuthenticatedUser, RequireClaim, RequireRole } from './requirement.js'
import { AuthzPolicyResult, AuthzRequirementHandler } from './policy.js'

export class AuthenticatedUserHandler extends AuthzRequirementHandler<RequireAuthenticatedUser> {
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

export class RoleHandler extends AuthzRequirementHandler<RequireRole> {
  get kind(): string {
    return 'role'
  }

  async handle(ctx: Context, user: Principal, requirement: RequireRole): Promise<AuthzPolicyResult> {
    if (requirement.roles.every(role => user.isInRole(role))) {
      return { ok: true }
    }

    return { ok: false, reason: 'User is not in all of the required roles' }
  }
}

export class ClaimHandler extends AuthzRequirementHandler<RequireClaim> {
  get kind(): string {
    return 'claim'
  }

  async handle(ctx: Context, user: Principal, requirement: RequireClaim): Promise<AuthzPolicyResult> {
    if (requirement.claimValues.length === 0 && user.hasClaim(requirement.claim)) {
      return { ok: true }
    }

    if (requirement.claimValues.some(v => user.hasClaim(requirement.claim, v))) {
      return { ok: true }
    }

    return { ok: false, reason: 'User does not have the required claim or claim value' }
  }
}

export class AssertionHandler extends AuthzRequirementHandler<RequireAssertion> {
  get kind(): string {
    return 'assertion'
  }

  async handle(ctx: Context, user: Principal, requirement: RequireAssertion): Promise<AuthzPolicyResult> {
    const passed = await requirement.assertion(ctx)
    if (passed) {
      return { ok: true }
    }
    return { ok: false, reason: 'Assertion failed' }
  }
}
