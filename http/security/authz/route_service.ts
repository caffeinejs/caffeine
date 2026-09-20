import { Context } from '../../context.js'
import { Principal } from '../index.js'
import { AuthzResult, PolicyEvaluator } from './policy.js'

export class AuthzRouteService {
  readonly #evaluators: PolicyEvaluator[]

  constructor(evaluators: PolicyEvaluator[]) {
    this.#evaluators = evaluators
  }

  /** Every evaluator has to allow. A promise only when one of them had to wait for its answer. */
  authorize(ctx: Context, user: Principal, resource?: unknown): AuthzResult | Promise<AuthzResult> {
    return this.#authorize(ctx, user, resource, 0)
  }

  #authorize(ctx: Context, user: Principal, resource: unknown, from: number): AuthzResult | Promise<AuthzResult> {
    for (let i = from; i < this.#evaluators.length; i++) {
      const result = this.#evaluators[i](ctx, user, resource)

      if (result instanceof Promise) {
        return result.then(settled => (settled.ok ? this.#authorize(ctx, user, resource, i + 1) : settled))
      }

      if (!result.ok) {
        return result
      }
    }

    return { ok: true }
  }
}
