import fp from 'fastify-plugin'

import type { HTTPPlugin } from '../plugin.js'
import type { HealthOptions } from './options.js'
import { ProbeEndpoint } from './probes.js'
import { installHealthProbes } from './probes_route.js'

/**
 * Mounts the three probes on the root server.
 *
 * Contributed by a feature the application bootstraps before any of its own, so the probes are registered
 * before anything a package contributes — an orchestrator polling `/readyz` must not be answered by a
 * fallback that happened to register a catch-all first.
 */
export function healthProbesPlugin(options: HealthOptions): HTTPPlugin {
  const plugin: HTTPPlugin = async (instance, opts) => {
    // Resolved even when the probes are off, because resolving is what checks that every health indicator
    // is a singleton — a lifetime mistake belongs to start-up, not to the first request that reads a probe.
    const probes = opts.container.get(ProbeEndpoint)

    if (!options.enabled) {
      return
    }

    installHealthProbes({ ...opts, server: instance }, options, probes)
  }

  return fp(plugin, { name: 'caffeine-health-probes' })
}
