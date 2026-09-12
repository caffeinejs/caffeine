import { Scopes } from '@caffeinejs/di'
import {
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type BootstrapKit,
  type Feature,
  type FeatureConfigureKit,
} from '@caffeinejs/std'

import { registerPlugin } from '../plugin.js'
import { kConstraintRegistry } from './keys.js'
import { constraintsPlugin } from './plugin.js'
import { ConstraintRegistry, type RegisteredConstraint } from './registry.js'
import type { ConstraintStrategy } from './strategy.js'

/**
 * Registers the custom route-selection constraints an application accepts on a route.
 *
 * Configured with `app.constraints(c => c.register(...))`. `version` is always available and needs nothing
 * registered — it is Fastify's built-in semver matcher on `Accept-Version`. A strategy is a function, so it is
 * held here and installed at start-up rather than travelling through the configuration tree.
 */
export class ConstraintsBuilder implements Feature {
  readonly [kFeatureName] = 'constraints'

  readonly #entries: RegisteredConstraint[] = []
  #registry: ConstraintRegistry | undefined

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

  [kFeatureConfigure](kit: FeatureConfigureKit): void {
    const registry = new ConstraintRegistry(this.#entries)
    this.#registry = registry

    kit.container.bind(kConstraintRegistry, t => t.toValue(registry).lifetime(Scopes.SINGLETON).internal())
  }

  [kFeatureBootstrap](kit: BootstrapKit): void {
    const registry = this.#registry
    if (registry !== undefined && registry.strategies().length > 0) {
      registerPlugin(kit, constraintsPlugin(registry))
    }
  }
}
