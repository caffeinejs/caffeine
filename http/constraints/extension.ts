import { kExtensionStage, type ExtensionStage } from '@caffeinejs/std'

import { ServerExtension, type ServerExtensionContext } from '../server_extension.js'
import type { ConstraintRegistry } from './registry.js'

/**
 * Installs the application's custom constraint strategies on the router.
 *
 * `core`, so `addConstraintStrategy` runs before any route is registered — find-my-way rejects a route that
 * names a strategy it does not know yet. Registered only when `app.constraints(...)` added at least one strategy.
 */
export class ConstraintRegistryExtension extends ServerExtension {
  readonly name = 'caffeine-constraints'
  readonly [kExtensionStage]: ExtensionStage = 'core'

  readonly #registry: ConstraintRegistry

  constructor(registry: ConstraintRegistry) {
    super()
    this.#registry = registry
  }

  configure(ctx: ServerExtensionContext): void {
    for (const strategy of this.#registry.strategies()) {
      if (!ctx.server.hasConstraintStrategy(strategy.name)) {
        ctx.server.addConstraintStrategy(strategy as never)
      }
    }
  }
}
