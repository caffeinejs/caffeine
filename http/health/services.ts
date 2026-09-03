import type { ApplicationAvailability } from '@caffeinejs/std'

import type { HealthOptions } from './options.js'
import type { ProbeEndpoint } from './probes.js'
import type { HealthRegistry } from './registry.js'

/** The resolved health feature handed to the adapter, alongside the other {@link Services}. */
export interface HealthServices {
  options: HealthOptions
  availability: ApplicationAvailability
  registry: HealthRegistry
  probes: ProbeEndpoint
}
