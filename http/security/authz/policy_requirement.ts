import { Context } from '../../context.js'
import { AuthzRequirement } from './policy.js'

export interface AuthenticatedUserRequirement extends AuthzRequirement {
  readonly kind: 'authenticated'
}

export interface RoleRequirement extends AuthzRequirement {
  readonly kind: 'role'
  readonly roles: readonly string[]
}

export interface ClaimRequirement extends AuthzRequirement {
  readonly kind: 'claim'
  readonly claim: string
  readonly claimValues: readonly unknown[]
}

export interface AssertionRequirement extends AuthzRequirement {
  readonly kind: 'assertion'
  readonly assertion: (ctx: Context) => boolean | Promise<boolean>
}
