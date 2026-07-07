import { Container, Scopes } from '@caffeinejs/core'
import { AuthzPolicy, AuthzRequirement, AuthzRequirementHandler, newPolicyEvaluator, PolicyEvaluator } from './policy.js'
import { PolicyBuilder } from './policy.builder.js'
import { AuthorizationService } from './service.js'
import { kAuthzEvaluators, kAuthzHandlers, kAuthzOpts } from './keys.js'

export interface AuthorizationBuildResult {
  evaluators: Map<string, PolicyEvaluator>
  handlers: Map<string, AuthzRequirementHandler<AuthzRequirement>>
  options: AuthorizationOptions
}

export interface AuthorizationOptions {
  authorizeDecoratorDefaultPolicy: AuthzPolicy
  fallbackPolicy?: AuthzPolicy
}

export class AuthorizationBuilder {
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

  fallbackPolicy(policy: AuthzPolicy): this
  fallbackPolicy(configure: (builder: PolicyBuilder) => void): this
  fallbackPolicy(
    policyOrConfigure: AuthzPolicy | ((builder: PolicyBuilder) => void),
  ): this {
    if (typeof policyOrConfigure === 'function') {
      const builder = new PolicyBuilder()
      policyOrConfigure(builder)

      this.#fallbackPolicy = builder.build()

      return this
    }

    this.#fallbackPolicy = policyOrConfigure

    return this
  }

  build(
    container: Container,
    handlersList: AuthzRequirementHandler<AuthzRequirement>[],
  ): AuthorizationBuildResult {
    const handlers = new Map<string, AuthzRequirementHandler<AuthzRequirement>>(
      handlersList.map(h => [h.kind, h]),
    )
    const evaluators = new Map(this.#policies
      .entries()
      .map(([name, policy]) => [name, newPolicyEvaluator(policy, handlers)]))
    const service = new AuthorizationService(evaluators)
    const options: AuthorizationOptions = {
      authorizeDecoratorDefaultPolicy: this.#authzDecoratorPolicy,
      fallbackPolicy: this.#fallbackPolicy,
    }

    container.bind(AuthorizationService).toValue(service).lifetime(Scopes.SINGLETON)
    container.bind(kAuthzOpts).toValue(options).lifetime(Scopes.SINGLETON)
    container.bind(kAuthzEvaluators).toValue(evaluators).lifetime(Scopes.SINGLETON)
    container.bind(kAuthzHandlers).toValue(handlers).lifetime(Scopes.SINGLETON)

    return { evaluators, handlers, options }
  }
}
