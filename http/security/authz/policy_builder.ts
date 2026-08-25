import { Context } from '../../context.js'
import type { Principal } from '../index.js'
import { AuthzPolicy, type AuthzRequirement } from './policy.js'
import type { AssertionRequirement, AuthenticatedUserRequirement, ClaimRequirement, ResourceRequirement, RoleRequirement } from './policy_requirement.js'

export class PolicyBuilder {
  readonly #requirements: AuthzRequirement[] = []

  requireAuthenticated(): this {
    this.#requirements.push({ kind: 'authenticated' } as AuthenticatedUserRequirement)
    return this
  }

  role(...roles: string[]): this {
    this.#requirements.push({ kind: 'role', roles } as RoleRequirement)
    return this
  }

  claim(claimType: string, ...allowedValues: unknown[]): this {
    this.#requirements.push({ kind: 'claim', claim: claimType, claimValues: allowedValues } as ClaimRequirement)
    return this
  }

  assert(pred: (ctx: Context) => boolean | Promise<boolean>): this {
    this.#requirements.push({ kind: 'assertion', assertion: pred } as AssertionRequirement)
    return this
  }

  resource<R = unknown>(authorize: (user: Principal, resource: R, ctx: Context) => boolean | Promise<boolean>): this {
    this.#requirements.push({ kind: 'resource', authorize } as ResourceRequirement)
    return this
  }

  requirement(requirement: AuthzRequirement): this {
    this.#requirements.push(requirement)
    return this
  }

  build(name?: string): AuthzPolicy {
    return {
      name: name ?? '',
      requirements: [...this.#requirements],
    }
  }
}
