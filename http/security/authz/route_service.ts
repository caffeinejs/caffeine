import { Context } from '../../context.js'
import { Principal } from '../index.js'
import { AuthzResult, PolicyEvaluator } from './policy.js'

export class AuthzRouteService {
  readonly #evaluators: PolicyEvaluator[]

  constructor(evaluators: PolicyEvaluator[]) {
    this.#evaluators = evaluators
  }

  async authorize(ctx: Context, user: Principal): Promise<AuthzResult> {
    for (const evaluator of this.#evaluators) {
      const result = await evaluator(ctx, user)
      if (!result.ok) {
        return result
      }
    }

    return { ok: true }
  }
}
