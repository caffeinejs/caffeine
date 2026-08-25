import { Context } from '../../context.js'
import { RouteAuthzOptions } from '../../decorators/registrar/routing.js'
import { Principal } from '../index.js'
import { AuthzRouteService } from './route_service.js'
import { AuthorizationOptions } from './authz.js'
import { PolicyBuilder } from './policy_builder.js'

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
    ctx: Context, user: Principal, requirement: R, resource?: unknown): AuthzPolicyResult | Promise<AuthzPolicyResult>
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

export type PolicyEvaluator
  = (ctx: Context, user: Principal, resource?: unknown) => AuthzResult | Promise<AuthzResult>

export function newPolicyEvaluator(
  policy: AuthzPolicy,
  handlers: Map<string, AuthzRequirementHandler<AuthzRequirement>>,
): PolicyEvaluator {
  const compiled
    = new Array<[AuthzRequirement, AuthzRequirementHandler<AuthzRequirement>]>(policy.requirements.length)

  for (let i = 0; i < policy.requirements.length; i++) {
    const requirement = policy.requirements[i]
    const handler = handlers.get(requirement.kind)
    if (!handler) {
      throw new Error(`Cannot compile policy: handler for requirement "${requirement.kind}" not found`)
    }

    compiled[i] = [requirement, handler]
  }

  return async (ctx: Context, user: Principal, resource?: unknown) => {
    for (const [requirement, handler] of compiled) {
      const result = await handler.handle(ctx, user, requirement, resource)
      if (!result.ok) {
        // Fail-fast: upon first failure,
        // stop executing and return the result immediately.
        return { ok: false, failedRequirement: requirement, failedPolicy: policy.name, reason: result.reason }
      }
    }

    return { ok: true }
  }
}

export function compileRoutePolicy(
  options: AuthorizationOptions,
  evaluators: Map<string, PolicyEvaluator>,
  handlers: Map<string, AuthzRequirementHandler<AuthzRequirement>>,
  routerOptions: RouteAuthzOptions = {},
  routeOptions: RouteAuthzOptions = {},
): AuthzRouteService | undefined {
  const anonymous
    = (routerOptions.allowAnonymous !== undefined && routerOptions.allowAnonymous)
      || (routeOptions.allowAnonymous !== undefined && routeOptions.allowAnonymous)

  if (anonymous) {
    return undefined
  }

  const routerPolicies = normalizePolicy(routerOptions.policy)
  const routePolicies = normalizePolicy(routeOptions.policy)

  // `schemes` is deliberately not part of this test. It selects *which* scheme authenticates and issues the
  // challenge; it states no requirement of its own, and nothing below turns it into one. Counting it here made
  // `@Authorize({ schemes: [...] })` skip the default policy and then compile to an empty one — so naming a
  // scheme, which reads as tightening the rule, silently let every anonymous request through.
  const routerEmpty = !routerPolicies.length && !routerOptions.roles?.length
  const routeEmpty = !routePolicies.length && !routeOptions.roles?.length

  if (routerEmpty && routeEmpty) {
    return new AuthzRouteService([newPolicyEvaluator(options.authorizeDecoratorDefaultPolicy, handlers)])
  }

  const policyNames = new Set<string>()
  for (const name of routerPolicies) {
    policyNames.add(name)
  }
  for (const name of routePolicies) {
    policyNames.add(name)
  }

  const evals = new Array<PolicyEvaluator>()
  for (const name of policyNames) {
    const e = evaluators.get(name)
    if (!e) {
      throw new Error(`Cannot compile route policy: evaluator for "${name}" not found`)
    }

    evals.push(e)
  }

  const builder = new PolicyBuilder()

  if (routerOptions.roles && routerOptions.roles.length > 0) {
    builder.role(...routerOptions.roles)
  }
  if (routeOptions.roles && routeOptions.roles.length > 0) {
    builder.role(...routeOptions.roles)
  }

  evals.push(newPolicyEvaluator(builder.build(), handlers))

  return new AuthzRouteService(evals)
}

function normalizePolicy(policy: string | string[] | undefined): string[] {
  if (policy == null) {
    return []
  }

  return Array.isArray(policy) ? policy : [policy]
}
