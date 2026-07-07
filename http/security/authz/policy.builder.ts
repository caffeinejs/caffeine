import { Context } from '../../context.js'
import { AuthzPolicy } from './policy.js'
import { requireAuthenticatedUser, requireRole, requireClaim, requireAssertion } from './requirement.js'
import { type AuthzRequirement } from './policy.js'

export class PolicyBuilder {
  readonly #requirements: AuthzRequirement[] = []
  readonly #authSchemes: string[] = []

  requireAuthenticated(): this {
    this.#requirements.push(requireAuthenticatedUser())
    return this
  }

  requireRole(...roles: string[]): this {
    this.#requirements.push(requireRole(...roles))
    return this
  }

  requireClaim(claimType: string, ...allowedValues: unknown[]): this {
    this.#requirements.push(requireClaim(claimType, ...allowedValues))
    return this
  }

  requireAssertion(
    handler: (ctx: Context) => boolean | Promise<boolean>,
  ): this {
    this.#requirements.push(requireAssertion(handler))
    return this
  }

  requireAuthenticationSchemes(...schemes: string[]): this {
    this.#authSchemes.push(...schemes)
    return this
  }

  addRequirement(requirement: AuthzRequirement): this {
    this.#requirements.push(requirement)
    return this
  }

  build(name?: string): AuthzPolicy {
    return {
      name: name ?? '',
      requirements: [...this.#requirements],
      authenticationSchemes: this.#authSchemes.length > 0 ? [...this.#authSchemes] : undefined,
    }
  }
}
