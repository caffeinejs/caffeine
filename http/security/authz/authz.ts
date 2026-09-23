import type { Container } from '@caffeinejs/di'
import { Scopes } from '@caffeinejs/di'
import { kFeatureConfigure, kFeatureName, type Feature, type FeatureConfigureKit } from '@caffeinejs/std'

import type { RouteGroup } from '../../route.js'
import {
  ErrAuthorizationRequired,
  ErrAuthzFallbackExcept,
  ErrAuthzPolicyEmpty,
  ErrAuthzRequirementHandlerDuplicate,
} from './errors.js'
import { AuthenticatedUserHandler, AssertionHandler, ClaimHandler, ResourceHandler, RoleHandler } from './handlers.js'
import { kAuthzEvaluators, kAuthzHandlers, kAuthzOpts } from './keys.js'
import { AuthzPolicy, AuthzRequirement, AuthzRequirementHandler, newPolicyEvaluator } from './policy.js'
import { PolicyBuilder } from './policy_builder.js'
import { AuthorizationService } from './service.js'

export interface AuthorizationOptions {
  /** What a bare `@Authorize` means. */
  authorizeDecoratorDefaultPolicy: AuthzPolicy
  /**
   * Applied to routes that carry no `@Authorize` / `@Roles` at all. Unset by default, so such routes are
   * open.
   */
  fallbackPolicy?: AuthzPolicy
  /** Path prefixes of routes registered straight on the server that the fallback policy leaves open. */
  fallbackExcept?: readonly string[]
}

export interface FallbackPolicyOptions {
  /**
   * Path prefixes the fallback policy leaves open, for routes a plugin registered straight on the server —
   * `/assets/` for the static files a login page loads. A route the application's own router compiled opts out
   * with `@AllowAnonymous` instead, and is not affected by this list.
   *
   * Matched against the path the route was registered under, never against the URL of the request, so no spelling
   * of a URL reaches a route on another route's exemption.
   *
   * A prefix is made of whole segments, with or without its trailing slash: `/assets` leaves `/assets` and
   * `/assets/app.js` open, and `/assets-old` guarded.
   */
  except?: readonly string[]
}

export class AuthorizationBuilder implements Feature {
  readonly [kFeatureName] = 'authz'

  readonly #policies: Map<string, AuthzPolicy> = new Map()

  #authzDecoratorPolicy: AuthzPolicy = new PolicyBuilder().requireAuthenticated().build()

  #fallbackPolicy: AuthzPolicy | undefined
  #fallbackExcept: readonly string[] = []

  /** @throws ErrAuthzPolicyEmpty when the policy has no requirement, which would allow every caller. */
  addPolicy(policy: AuthzPolicy): this
  addPolicy(name: string, configure: (builder: PolicyBuilder) => void): this
  addPolicy(nameOrPolicy: string | AuthzPolicy, configure?: (builder: PolicyBuilder) => void): this {
    if (typeof nameOrPolicy === 'string') {
      const builder = new PolicyBuilder()
      configure?.(builder)

      this.#policies.set(nameOrPolicy, requirements(builder.build(nameOrPolicy), nameOrPolicy))

      return this
    }

    this.#policies.set(nameOrPolicy.name, requirements(nameOrPolicy, nameOrPolicy.name))

    return this
  }

  /**
   * What a bare `@Authorize` means. Requires an authenticated user unless set.
   *
   * @throws ErrAuthzPolicyEmpty when the policy has no requirement, which would allow every caller.
   */
  authorizeDecoratorDefaultPolicy(policy: AuthzPolicy): this
  authorizeDecoratorDefaultPolicy(configure: (builder: PolicyBuilder) => void): this
  authorizeDecoratorDefaultPolicy(policyOrConfigure: AuthzPolicy | ((builder: PolicyBuilder) => void)): this {
    this.#authzDecoratorPolicy = requirements(built(policyOrConfigure), 'authorizeDecoratorDefaultPolicy')

    return this
  }

  /**
   * Gates every route that carries no `@Authorize` / `@Roles` of its own — the ones a plugin registered straight
   * on the server included, since there is no decorator on those for anyone to forget.
   *
   * What stays open under it: a route declared public, a health probe, the callback an OAuth strategy receives
   * its redirect on, a route registered with `authenticationExempt()`, the prefixes listed in
   * {@link FallbackPolicyOptions.except}, and a URL no route matches, which is answered 404 as it always was.
   *
   * Off by default, because turning it on changes what an *undecorated* route means and that has to be a
   * deliberate posture rather than something a dependency bump introduces. Turning it on is the difference
   * between "a route is public unless someone remembered to protect it" and "a route is protected unless
   * someone declared it public" — the second is the only one where forgetting is safe. `@AllowAnonymous`
   * is the opt-out.
   *
   * It does not affect decorated routes: those already state their own rule, and a bare `@Authorize`
   * continues to mean {@link authorizeDecoratorDefaultPolicy}.
   *
   * @throws ErrAuthzPolicyEmpty when the policy has no requirement, which would allow every caller.
   */
  fallbackPolicy(policy: AuthzPolicy, options?: FallbackPolicyOptions): this
  fallbackPolicy(configure: (builder: PolicyBuilder) => void, options?: FallbackPolicyOptions): this
  fallbackPolicy(
    policyOrConfigure: AuthzPolicy | ((builder: PolicyBuilder) => void),
    options: FallbackPolicyOptions = {},
  ): this {
    const except = options.except ?? []
    const relative = except.find(prefix => !prefix.startsWith('/'))
    if (relative !== undefined) {
      throw new ErrAuthzFallbackExcept(relative)
    }

    this.#fallbackPolicy = requirements(built(policyOrConfigure), 'fallbackPolicy')
    this.#fallbackExcept = [...except]

    return this
  }

  /** Shorthand for the common posture: every undecorated route requires an authenticated user. */
  requireAuthenticatedByDefault(options?: FallbackPolicyOptions): this {
    return this.fallbackPolicy(p => p.requireAuthenticated(), options)
  }

  [kFeatureConfigure](kit: FeatureConfigureKit): void {
    kit.container.bind(AuthenticatedUserHandler, t =>
      t.toSelf().lifetime(Scopes.SINGLETON).extends(AuthzRequirementHandler).internal(),
    )
    kit.container.bind(RoleHandler, t =>
      t.toSelf().lifetime(Scopes.SINGLETON).extends(AuthzRequirementHandler).internal(),
    )
    kit.container.bind(ClaimHandler, t =>
      t.toSelf().lifetime(Scopes.SINGLETON).extends(AuthzRequirementHandler).internal(),
    )
    kit.container.bind(AssertionHandler, t =>
      t.toSelf().lifetime(Scopes.SINGLETON).extends(AuthzRequirementHandler).internal(),
    )
    kit.container.bind(ResourceHandler, t =>
      t.toSelf().lifetime(Scopes.SINGLETON).extends(AuthzRequirementHandler).internal(),
    )

    // Public (not internal): features inject AuthorizationService for imperative resource checks.
    kit.container.bind(AuthorizationService, t => t.toSelf([kAuthzEvaluators]).lifetime(Scopes.SINGLETON))

    kit.container.bind(kAuthzOpts, t =>
      t
        .toValue({
          authorizeDecoratorDefaultPolicy: this.#authzDecoratorPolicy,
          fallbackPolicy: this.#fallbackPolicy,
          fallbackExcept: this.#fallbackExcept,
        })
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )

    kit.container.bind(kAuthzHandlers, t =>
      t
        .toFactory(ctx => {
          const handlers = new Map<string, AuthzRequirementHandler<AuthzRequirement>>()

          for (const handler of ctx.container.getMany(AuthzRequirementHandler)) {
            if (handlers.has(handler.kind)) {
              throw new ErrAuthzRequirementHandlerDuplicate(handler.kind)
            }

            handlers.set(handler.kind, handler)
          }

          return handlers
        })
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )

    kit.container.bind(kAuthzEvaluators, t =>
      t
        .toFactory(ctx => {
          const handlers = ctx.container.get<Map<string, AuthzRequirementHandler<AuthzRequirement>>>(kAuthzHandlers)

          return new Map(this.#policies.entries().map(([name, policy]) => [name, newPolicyEvaluator(policy, handlers)]))
        })
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )
  }
}

function built(policyOrConfigure: AuthzPolicy | ((builder: PolicyBuilder) => void)): AuthzPolicy {
  if (typeof policyOrConfigure !== 'function') {
    return policyOrConfigure
  }

  const builder = new PolicyBuilder()
  policyOrConfigure(builder)

  return builder.build()
}

/** The policy itself, once it is known to hold at least one requirement. */
function requirements(policy: AuthzPolicy, name: string): AuthzPolicy {
  if (policy.requirements.length === 0) {
    throw new ErrAuthzPolicyEmpty(name)
  }

  return policy
}

/**
 * Refuses an application that protects a route and never configured authorization.
 *
 * Checked apart from route compilation because a route that declares protection with authorization absent
 * compiles with no real policy — see `declaresAuthzProtection` in `routing/compile.ts` — so the cause is
 * named here rather than surfacing as a missing handler or policy.
 *
 * @throws ErrAuthorizationRequired when a route declares protection and authorization was never installed.
 */
export function assertAuthorizationConfigured(container: Container, routeGroups: readonly RouteGroup<any>[]): void {
  if (container.getOptional(kAuthzOpts) !== undefined) {
    return
  }

  if (routeGroups.some(group => group.routes.some(route => route.authorization.hasProtection))) {
    throw new ErrAuthorizationRequired()
  }
}
