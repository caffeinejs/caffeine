import type { ApplicationAvailability, HealthIndicator } from '@caffeinejs/std/health'

import type { HealthOptions } from './options.js'
import { ProbeEndpoint } from './probes.js'
import { HealthRegistry } from './registry.js'

/** What `health()` needs to wire into an adapter: the evaluated registry and the probe endpoints it drives. */
export interface HealthComponents {
  registry: HealthRegistry
  probes: ProbeEndpoint
}

/**
 * Builds the health components from plain data — no container, no HTTP framework. This is the piece an
 * adapter's plugin calls into; a Fastify plugin resolves `indicators` and `availability` from the container
 * once, as it registers, and everything past this point is framework-agnostic.
 */
export function healthComponents(
  options: HealthOptions,
  indicators: readonly HealthIndicator[],
  availability: ApplicationAvailability,
): HealthComponents {
  const registry = new HealthRegistry(indicators, options)
  const probes = new ProbeEndpoint(availability, registry, options)

  return { registry, probes }
}
