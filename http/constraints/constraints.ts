import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { ErrConfiguration } from '../error/index.js'
import { solutions } from '../error/util.js'
import { appendVary } from '../vary.js'
import type { ConstraintStrategy } from './strategy.js'

export const VERSION_CONSTRAINT = 'version'

export const kVersionHeader = 'Accept-Version'
export const kRouteConstraints = 'caffeine:constraints'

/** The name {@link constraints} registers its plugin under. */
export const CONSTRAINTS_PLUGIN = '@caffeinejs/http/constraints'

/** One declared route constraint: the value it must match, and the request header it reads, when it reads one. */
export interface ResolvedRouteConstraint {
  value: unknown
  header?: string
}

/**
 * Enables route constraints: registers custom find-my-way strategies, resolves each route's `@Constraint` /
 * `constraint()` / `@Version` declaration into Fastify's `constraints` matching object, and adds every declared
 * constraint header to `Vary`.
 *
 * Required for any constrained route, `version` included: `.with(() => constraints())`, or
 * `.with(() => constraints([myStrategy]))` for a custom name. `version` needs no strategy — it is Fastify's
 * built-in semver matcher. An application with a constrained route and no plugin fails at start-up.
 *
 * `Vary` is set on every response once any route is constrained: a versioned route and its unversioned twin share
 * a URL, so a cache keyed on the URL alone would serve one client the other's representation.
 *
 * @throws ErrConfiguration when a route sets one constraint name through both `fst({ constraints })` and
 * `@Constraint` / `constraint()`
 */
export function constraints(strategies: readonly ConstraintStrategy[] = []): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    for (const strategy of strategies) {
      if (!instance.hasConstraintStrategy(strategy.name)) {
        instance.addConstraintStrategy(strategy as never)
      }
    }

    const vary: string[] = []

    instance.addHook('onRoute', options => {
      const config = options.config as Record<string, unknown> | undefined
      const declared = config?.[kRouteConstraints] as Map<string, ResolvedRouteConstraint> | undefined
      if (declared === undefined || declared.size === 0) {
        return
      }

      const existing = options.constraints as Record<string, unknown> | undefined
      const resolved: Record<string, unknown> = { ...existing }

      for (const [name, constraint] of declared) {
        if (existing !== undefined && name in existing) {
          throw new ErrConfiguration(
            `Cannot register "${options.method} ${options.url}": constraint "${name}" is set by both ` +
              `"fst({ constraints })" and "@Constraint" or "constraint()"` +
              solutions(
                `Remove "${name}" from the "fst({ constraints })" call`,
                'Declare each constraint one way only',
              ),
          )
        }

        resolved[name] = constraint.value
        if (constraint.header !== undefined && !vary.includes(constraint.header)) {
          vary.push(constraint.header)
        }
      }

      options.constraints = resolved
    })

    // Added now, not once the headers are known: a route takes the hooks in place when it registers.
    instance.addHook('onSend', (_request, reply, payload, done) => {
      if (vary.length > 0) {
        appendVary(reply, vary)
      }

      done(null, payload)
    })
  }

  return fp(plugin, { name: CONSTRAINTS_PLUGIN })
}
