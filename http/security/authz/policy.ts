import { Context } from '../../context.js'
import type { RouteAuthz } from '../../routing/spec.js'
import { Principal } from '../index.js'
import { AuthorizationOptions } from './authz.js'
import { ErrAuthzPolicyNotFound, ErrAuthzRequirementHandlerNotFound } from './errors.js'
import { PolicyBuilder } from './policy_builder.js'
import { AuthzRouteService } from './route_service.js'

export interface AuthzPolicy {
  readonly name: string
  readonly requirements: readonly AuthzRequirement[]
}

export interface AuthzRequirement {
  readonly kind: string
}

export abstract class AuthzRequirementHandler<R extends AuthzRequirement> {
  abstract get kind(): string

  abstract handle(
    ctx: Context,
    user: Principal,
    requirement: R,
    resource?: unknown,
  ): AuthzPolicyResult | Promise<AuthzPolicyResult>
}

export interface AuthzResult {
  readonly ok: boolean
  readonly reason?: Error | string
  readonly failedPolicy?: string
  readonly failedRequirement?: AuthzRequirement
}

export interface AuthzPolicyResult {
  ok: boolean
  reason?: Error | string
}

export type PolicyEvaluator = (ctx: Context, user: Principal, resource?: unknown) => AuthzResult | Promise<AuthzResult>

export function newPolicyEvaluator(
  policy: AuthzPolicy,
  handlers: Map<string, AuthzRequirementHandler<AuthzRequirement>>,
): PolicyEvaluator {
  const compiled = new Array<[AuthzRequirement, AuthzRequirementHandler<AuthzRequirement>]>(policy.requirements.length)

  for (let i = 0; i < policy.requirements.length; i++) {
    const requirement = policy.requirements[i]
    const handler = handlers.get(requirement.kind)
    if (!handler) {
      throw new ErrAuthzRequirementHandlerNotFound(requirement.kind)
    }

    compiled[i] = [requirement, handler]
  }

  const failed = (requirement: AuthzRequirement, result: AuthzPolicyResult): AuthzResult => ({
    ok: false,
    failedRequirement: requirement,
    failedPolicy: policy.name,
    reason: result.reason,
  })

  // Fail-fast: the first requirement that is not met ends the evaluation. Most requirements answer at once, so
  // the evaluation only becomes a promise at the first one that does not.
  const evaluate = (
    ctx: Context,
    user: Principal,
    resource: unknown,
    from: number,
  ): AuthzResult | Promise<AuthzResult> => {
    for (let i = from; i < compiled.length; i++) {
      const [requirement, handler] = compiled[i]
      const result = handler.handle(ctx, user, requirement, resource)

      if (result instanceof Promise) {
        return result.then(settled =>
          settled.ok ? evaluate(ctx, user, resource, i + 1) : failed(requirement, settled),
        )
      }

      if (!result.ok) {
        return failed(requirement, result)
      }
    }

    return ALLOWED
  }

  return (ctx, user, resource) => evaluate(ctx, user, resource, 0)
}

const ALLOWED: AuthzResult = Object.freeze({ ok: true })

/**
 * Compiles the authorization a route actually runs, or `undefined` when it runs none.
 *
 * @param authz - Everything declared for the route, its groups included, as `mergeAuthz` combined it. `undefined`
 * means nothing was declared at any level, which is what {@link AuthorizationOptions.fallbackPolicy} covers.
 * @throws ErrAuthzPolicyNotFound when a declaration names a policy that was never registered.
 */
export function compileRoutePolicy(
  options: AuthorizationOptions,
  evaluators: Map<string, PolicyEvaluator>,
  handlers: Map<string, AuthzRequirementHandler<AuthzRequirement>>,
  authz?: RouteAuthz,
): AuthzRouteService | undefined {
  if (authz === undefined) {
    return options.fallbackPolicy === undefined
      ? undefined
      : new AuthzRouteService([newPolicyEvaluator(options.fallbackPolicy, handlers)])
  }

  if (authz.allowAnonymous) {
    return undefined
  }

  const evals: PolicyEvaluator[] = []

  // Naming schemes states no requirement: it selects which scheme authenticates and challenges. So a declaration
  // naming only schemes asks for the default policy, the same as a bare one — it must never compile to nothing.
  if (authz.defaultPolicy) {
    evals.push(newPolicyEvaluator(options.authorizeDecoratorDefaultPolicy, handlers))
  }

  for (const name of authz.policies) {
    const evaluator = evaluators.get(name)
    if (evaluator === undefined) {
      throw new ErrAuthzPolicyNotFound(name, [...evaluators.keys()])
    }

    evals.push(evaluator)
  }

  if (authz.roleGroups.length > 0) {
    const builder = new PolicyBuilder()
    for (const roles of authz.roleGroups) {
      builder.role(...roles)
    }

    evals.push(newPolicyEvaluator(builder.build(), handlers))
  }

  // A protected route that would run nothing is a declaration assembled by hand and wrongly: fail closed.
  if (evals.length === 0) {
    evals.push(newPolicyEvaluator(options.authorizeDecoratorDefaultPolicy, handlers))
  }

  return new AuthzRouteService(evals)
}
