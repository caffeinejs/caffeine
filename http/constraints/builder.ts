import { Scopes } from '@caffeinejs/di'
import { kBootstrap, kFeatureName, type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { ConstraintRegistryExtension } from './extension.js'
import { kConstraintRegistry } from './keys.js'
import { ConstraintRegistry, type RegisteredConstraint } from './registry.js'
import type { ConstraintStrategy } from './strategy.js'

/**
 * Registers the custom route-selection constraints an application accepts on a route.
 *
 * Configured with `app.constraints(c => c.register(...))`. `version` is always available and needs nothing
 * registered — it is Fastify's built-in semver matcher on `Accept-Version`. A strategy is a function, so it is
 * held here and installed at start-up rather than travelling through the configuration tree.
 */
export class ConstraintsBuilder implements FeatureLifecycle {
  readonly [kFeatureName] = 'constraints'

  readonly #entries: RegisteredConstraint[] = []

  /**
   * Registers `strategy` under `strategy.name`, so a route selects on it with `@Constraint(strategy.name, value)`
   * or `.constraint(strategy.name, value)`. Registering `version` replaces the built-in semver matcher.
   *
   * @param options - `header` names the request header the strategy reads, so a route that uses the constraint
   *   gets `Vary` set and the OpenAPI document lists the header
   */
  register(strategy: ConstraintStrategy, options?: { header?: string }): this {
    this.#entries.push({ name: strategy.name, header: options?.header, strategy })
    return this
  }

  [kBootstrap](kit: BootstrapKit): void {
    const registry = new ConstraintRegistry(this.#entries)

    kit.container.bind(kConstraintRegistry, t => t.toValue(registry).lifetime(Scopes.SINGLETON).internal())

    if (registry.strategies().length > 0) {
      kit.extensions.register(ConstraintRegistryExtension, new ConstraintRegistryExtension(registry))
    }
  }
}
