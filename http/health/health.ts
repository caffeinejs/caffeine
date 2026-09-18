import { ApplicationAvailability } from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import type { HTTPPluginFactory } from '../plugin.js'
import { HealthBuilder } from './builder.js'
import { healthComponents } from './components.js'
import { loadHealthIndicators } from './load.js'
import { installHealthProbes } from './probes_route.js'

/** Authors {@link HealthOptions} through {@link HealthBuilder} instead of a plain object. */
export type HealthConfigurer<C = unknown> = (builder: HealthBuilder, config: ConfigHandle<C>) => void

/**
 * The Kubernetes probes (`/livez`, `/readyz`, `/startupz`), as an ordinary Fastify plugin factory:
 * `.with(health())`.
 *
 * Installing the plugin at all is the opt-in — probes are on by default from there, unless `.k8s()` gates
 * that default on `KUBERNETES_SERVICE_HOST`, or `.enabled(false)` / a configured `enabled` turns them off
 * outright. Being a plain plugin factory rather than a feature, it binds nothing into the container: the
 * registry and the probe endpoints are built once, as the plugin registers, from indicators and the
 * application's {@link ApplicationAvailability} read off the container — never written back to it.
 *
 * Graceful shutdown — the drain sequence and the signal handlers — is a separate concern, configured with
 * `app.shutdown(...)`.
 */
export function health<C = unknown>(configure?: HealthConfigurer<C>): HTTPPluginFactory<C> {
  return ({ config, container }) => {
    const builder = new HealthBuilder()
    configure?.(builder, config)
    const options = builder.resolve()

    const plugin: FastifyPluginAsync = async instance => {
      // Resolved unconditionally: this is what catches a non-singleton HealthIndicator at start-up, whether
      // or not the probes themselves are enabled.
      const indicators = loadHealthIndicators(container)
      const availability = container.get(ApplicationAvailability)
      const { registry, probes } = healthComponents(options, indicators, availability)

      if (!options.enabled) {
        return
      }

      installHealthProbes(instance, options, probes)

      // Drops cached probe evaluations once the server starts closing, so a probe polled right as shutdown
      // begins does not serve a stale cached pass.
      instance.addHook('onClose', () => registry.invalidate())
    }

    return fp(plugin, { name: '@caffeinejs/http:health' })
  }
}
