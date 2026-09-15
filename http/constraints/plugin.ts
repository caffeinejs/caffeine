import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import type { ConstraintStrategy } from './strategy.js'

/** The constraint name API-version selection writes under, shared by `@Version`, `version()` and `vary_plugin`. */
export const VERSION_CONSTRAINT = 'version'
/** The request header find-my-way's built-in `version` strategy reads. */
export const kVersionHeader = 'Accept-Version'

/** The `route.config` key `constraint()` / `version()` write under. */
export const kRouteConstraints = 'caffeine:constraints'

/** One declared route constraint: the value it must match, and the request header it reads, when it reads one. */
export interface ResolvedRouteConstraint {
  value: unknown
  header?: string
}

/**
 * Registers custom find-my-way constraint strategies, so a route can select on them with
 * `@Constraint(name, value)` / `constraint(name, value)`.
 *
 * Opt-in, exactly like any third-party Fastify plugin: `.with(() => constraintsPlugin([myStrategy]))`. Must
 * finish registering before any route does — find-my-way rejects a route naming a strategy it does not know
 * yet — which every `.with(...)` plugin already does.
 *
 * `version` needs nothing here: it is Fastify's built-in semver matcher, always available without this plugin.
 */
export function constraintsPlugin(strategies: readonly ConstraintStrategy[]): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    for (const strategy of strategies) {
      if (!instance.hasConstraintStrategy(strategy.name)) {
        instance.addConstraintStrategy(strategy as never)
      }
    }
  }

  return fp(plugin, { name: 'constraints' })
}
