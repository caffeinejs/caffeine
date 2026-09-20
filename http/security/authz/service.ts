import { Context } from '../../context.js'
import { ErrHTTPForbidden } from '../../error/http.js'
import type { Principal } from '../index.js'
import { ErrAuthzPolicyNotFound } from './errors.js'
import { AuthzResult, PolicyEvaluator } from './policy.js'

export class AuthorizationService {
  readonly #evaluators: Map<string, PolicyEvaluator>

  constructor(evaluators: Map<string, PolicyEvaluator>) {
    this.#evaluators = evaluators
  }

  /**
   * Evaluates a named policy against a principal and an optional resource, returning the raw result.
   * Use {@link authorize} for the throwing, controller-facing variant.
   */
  async check(ctx: Context, user: Principal, policyName: string, resource?: unknown): Promise<AuthzResult> {
    const evaluator = this.#evaluators.get(policyName)
    if (!evaluator) {
      throw new ErrAuthzPolicyNotFound(policyName, [...this.#evaluators.keys()])
    }

    return evaluator(ctx, user, resource)
  }

  /**
   * Authorizes the request's current user against a named policy for a loaded resource. This is the imperative,
   * ownership-check entry point: load the entity in the handler, then call this with it.
   *
   * @throws ErrHTTPForbidden when the policy denies. What the client is told is "Forbidden" and no more: which
   * policy refused, and why, would tell a caller how the rules are laid out. Both are on the error's `cause`.
   */
  async authorize(ctx: Context, policyName: string, resource?: unknown): Promise<void> {
    const result = await this.check(ctx, ctx.user, policyName, resource)
    if (!result.ok) {
      const reason = typeof result.reason === 'string' ? result.reason : result.reason?.message
      const detail = reason ? `: ${reason}` : ''

      throw new ErrHTTPForbidden('Forbidden', {
        cause: new Error(`Authorization denied by policy "${policyName}"${detail}`),
      })
    }
  }

  async allows(ctx: Context, policyName: string, resource?: unknown): Promise<boolean> {
    return (await this.check(ctx, ctx.user, policyName, resource)).ok
  }

  async denies(ctx: Context, policyName: string, resource?: unknown): Promise<boolean> {
    return !(await this.allows(ctx, policyName, resource))
  }
}
