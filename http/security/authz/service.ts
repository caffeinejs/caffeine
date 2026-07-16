import { Context } from '../../context.js'
import type { Principal } from '../index.js'
import { AuthzResult, PolicyEvaluator } from './policy.js'

export class AuthorizationService {
  readonly #evaluators: Map<string, PolicyEvaluator>

  constructor(evaluators: Map<string, PolicyEvaluator>) {
    this.#evaluators = evaluators
  }

  async authorize(
    ctx: Context,
    user: Principal,
    policyName: string,
    resource?: unknown,
  ): Promise<AuthzResult> {
    const evaluator = this.#evaluators.get(policyName)
    if (!evaluator) {
      throw new Error(`Policy ${policyName} not found`)
    }

    return evaluator(ctx, user, resource)
  }
}
