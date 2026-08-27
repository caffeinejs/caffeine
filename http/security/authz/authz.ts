import { Scopes } from '@caffeinejs/di'
import { kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ServiceKit } from '../../service.js'
import { AuthzPolicy, AuthzRequirement, AuthzRequirementHandler, newPolicyEvaluator } from './policy.js'
import { PolicyBuilder } from './policy_builder.js'
import { AuthenticatedUserHandler, AssertionHandler, ClaimHandler, ResourceHandler, RoleHandler } from './handlers.js'
import { kAuthzEvaluators, kAuthzHandlers, kAuthzOpts } from './keys.js'
import { AuthorizationService } from './service.js'

export interface AuthorizationOptions {
  /** What a bare `@Authorize` means. */
  authorizeDecoratorDefaultPolicy: AuthzPolicy
  /**
   * Applied to routes that carry no `@Authorize` / `@Roles` at all. Unset by default, so such routes are
   * open.
   */
  fallbackPolicy?: AuthzPolicy
}

export class AuthorizationBuilder implements Service {
  readonly #policies: Map<string, AuthzPolicy> = new Map()

  #authzDecoratorPolicy: AuthzPolicy = new PolicyBuilder()
    .requireAuthenticated()
    .build()

  #fallbackPolicy: AuthzPolicy | undefined

  addPolicy(policy: AuthzPolicy): this
  addPolicy(name: string, configure: (builder: PolicyBuilder) => void): this
  addPolicy(
    nameOrPolicy: string | AuthzPolicy,
    configure?: (builder: PolicyBuilder) => void,
  ): this {
    if (typeof nameOrPolicy === 'string') {
      const builder = new PolicyBuilder()
      configure?.(builder)

      this.#policies.set(nameOrPolicy, builder.build(nameOrPolicy))

      return this
    }

    this.#policies.set(nameOrPolicy.name, nameOrPolicy)

    return this
  }

  authorizeDecoratorDefaultPolicy(policy: AuthzPolicy): this
  authorizeDecoratorDefaultPolicy(configure: (builder: PolicyBuilder) => void): this
  authorizeDecoratorDefaultPolicy(
    policyOrConfigure: AuthzPolicy | ((builder: PolicyBuilder) => void),
  ): this {
    if (typeof policyOrConfigure === 'function') {
      const builder = new PolicyBuilder()
      policyOrConfigure(builder)

      this.#authzDecoratorPolicy = builder.build()

      return this
    }

    this.#authzDecoratorPolicy = policyOrConfigure

    return this
  }

  /**
   * Gates every route that carries no `@Authorize` / `@Roles` of its own.
   *
   * Off by default, because turning it on changes what an *undecorated* route means and that has to be a
   * deliberate posture rather than something a dependency bump introduces. Turning it on is the difference
   * between "a route is public unless someone remembered to protect it" and "a route is protected unless
   * someone declared it public" — the second is the only one where forgetting is safe. `@AllowAnonymous`
   * is the opt-out.
   *
   * It does not affect decorated routes: those already state their own rule, and a bare `@Authorize`
   * continues to mean {@link authorizeDecoratorDefaultPolicy}.
   */
  fallbackPolicy(policy: AuthzPolicy): this
  fallbackPolicy(configure: (builder: PolicyBuilder) => void): this
  fallbackPolicy(policyOrConfigure: AuthzPolicy | ((builder: PolicyBuilder) => void)): this {
    if (typeof policyOrConfigure === 'function') {
      const builder = new PolicyBuilder()
      policyOrConfigure(builder)

      this.#fallbackPolicy = builder.build()

      return this
    }

    this.#fallbackPolicy = policyOrConfigure

    return this
  }

  /** Shorthand for the common posture: every undecorated route requires an authenticated user. */
  requireAuthenticatedByDefault(): this {
    return this.fallbackPolicy(p => p.requireAuthenticated())
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    kit.container.bind(AuthenticatedUserHandler)
      .toSelf()
      .lifetime(Scopes.SINGLETON)
      .extends(AuthzRequirementHandler)
      .internal()
    kit.container.bind(RoleHandler)
      .toSelf()
      .lifetime(Scopes.SINGLETON)
      .extends(AuthzRequirementHandler)
      .internal()
    kit.container.bind(ClaimHandler)
      .toSelf()
      .lifetime(Scopes.SINGLETON)
      .extends(AuthzRequirementHandler)
      .internal()
    kit.container.bind(AssertionHandler)
      .toSelf()
      .lifetime(Scopes.SINGLETON)
      .extends(AuthzRequirementHandler)
      .internal()
    kit.container.bind(ResourceHandler)
      .toSelf()
      .lifetime(Scopes.SINGLETON)
      .extends(AuthzRequirementHandler)
      .internal()

    // Public (not internal): features inject AuthorizationService for imperative resource checks.
    kit.container
      .bind(AuthorizationService)
      .toSelf([kAuthzEvaluators])
      .lifetime(Scopes.SINGLETON)

    kit.container
      .bind(kAuthzOpts)
      .toValue({
        authorizeDecoratorDefaultPolicy: this.#authzDecoratorPolicy,
        fallbackPolicy: this.#fallbackPolicy,
      })
      .lifetime(Scopes.SINGLETON)
      .internal()

    kit.container
      .bind(kAuthzHandlers)
      .toFactory(ctx => {
        const handlers
          = ctx.container.getMany(AuthzRequirementHandler)

        return new Map(handlers.map(h => [h.kind, h]))
      })
      .lifetime(Scopes.SINGLETON)
      .internal()

    kit.container
      .bind(kAuthzEvaluators)
      .toFactory(ctx => {
        const handlers
          = ctx.container.get<Map<string, AuthzRequirementHandler<AuthzRequirement>>>(kAuthzHandlers)

        return new Map(this.#policies
          .entries()
          .map(([name, policy]) => [name, newPolicyEvaluator(policy, handlers)]))
      })
      .lifetime(Scopes.SINGLETON)
      .internal()

    return Promise.resolve()
  }
}
