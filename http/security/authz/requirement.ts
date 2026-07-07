import { Context } from '../../context.js'
import { AuthzRequirement } from './policy.js'

export interface RequireAuthenticatedUser extends AuthzRequirement {
  readonly kind: 'authenticated'
}

export interface RequireRole extends AuthzRequirement {
  readonly kind: 'role'
  readonly roles: readonly string[]
}

export interface RequireClaim extends AuthzRequirement {
  readonly kind: 'claim'
  readonly claim: string
  readonly claimValues: readonly unknown[]
}

export interface RequireAssertion extends AuthzRequirement {
  readonly kind: 'assertion'
  readonly assertion: (ctx: Context) => boolean | Promise<boolean>
}

export function requireAuthenticatedUser(): RequireAuthenticatedUser {
  return { kind: 'authenticated' }
}

export function requireRole(...roles: string[]): RequireRole {
  return { kind: 'role', roles }
}

export function requireClaim(claimType: string, ...allowedValues: unknown[]): RequireClaim {
  return { kind: 'claim', claim: claimType, claimValues: allowedValues }
}

export function requireAssertion(
  assertion: (ctx: Context) => boolean | Promise<boolean>,
): RequireAssertion {
  return { kind: 'assertion', assertion }
}
