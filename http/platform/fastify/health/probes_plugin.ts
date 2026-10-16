import { ApplicationHealth } from '@caffeinejs/std/health'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { HealthProbesBuilder } from '../../../core/health/probes_builder.js'
import type { HTTPPluginConfigurer, HTTPPluginFactory } from '../plugin.js'
import { installHealthProbes } from './probes_route.js'

/**
 * The Kubernetes probes (`/livez`, `/readyz`, `/startupz`), answering from the application's
 * `ApplicationHealth`: `.with(healthProbes())`.
 *
 * Registering it is the opt-in for the routes — on by default from there, unless `.k8s()` gates that default
 * on `KUBERNETES_SERVICE_HOST`, or `.enabled(false)` / a configured `enabled` turns them off outright. The
 * budgets the probes answer under are the health feature's — `.install(Health(...))` — or the defaults when
 * it was never installed.
 */
export function healthProbes<C = unknown>(
  configure?: HTTPPluginConfigurer<HealthProbesBuilder, C>,
): HTTPPluginFactory<C> {
  return context => {
    const builder = new HealthProbesBuilder()
    configure?.(builder, context)

    const options = builder.resolve()

    return fp(
      async (instance: FastifyInstance) => {
        // Resolved before the `enabled` check: building the service is what rejects a non-singleton indicator,
        // and that belongs to start-up whether or not the probes are mounted.
        const health = context.container.get(ApplicationHealth)

        if (options.enabled) {
          installHealthProbes(instance, options, health)
        }
      },
      { name: 'caffeine-health-probes' },
    )
  }
}
