import { Context } from '../../context.js'
import { AuthzPolicy, type AuthzRequirement } from './policy.js'
import type { AssertionRequirement, AuthenticatedUserRequirement, ClaimRequirement, RoleRequirement } from './policy_requirement.js'

export class PolicyBuilder {
  readonly #requirements: AuthzRequirement[] = []
  readonly #authSchemes: string[] = []

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

  authenticationStrategies(...schemes: string[]): this {
    this.#authSchemes.push(...schemes)
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
      authenticationStrategies: this.#authSchemes.length > 0 ? [...this.#authSchemes] : undefined,
    }
  }
}
