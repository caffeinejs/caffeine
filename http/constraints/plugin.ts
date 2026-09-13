import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import type { ConstraintRegistry } from './registry.js'

/**
 * Installs the application's custom constraint strategies on the router.
 *
 * Contributed by a feature the application bootstraps before any of its own, so `addConstraintStrategy` runs
 * before any route is registered — find-my-way rejects a route that names a strategy it does not know yet.
 * Contributed only when `app.constraints(...)` added at least one strategy.
 */
export function constraintsPlugin(registry: ConstraintRegistry): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    for (const strategy of registry.strategies()) {
      if (!instance.hasConstraintStrategy(strategy.name)) {
        instance.addConstraintStrategy(strategy as never)
      }
    }
  }

  return fp(plugin, { name: 'caffeine-constraints' })
}
