import {
  ApplicationAvailability,
  type BeforeBootstrapKit,
  type BootstrapKit,
  type FeatureLifecycle,
} from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigSlice } from '@caffeinejs/std/config'

import { kHealthContribution } from './keys.js'
import {
  finalizeHealthOptions,
  healthConfigSchema,
  mergeHealthConfig,
  type HealthConfig,
  type HealthOptions,
} from './options.js'

/**
 * Binds what the health feature needs whether or not it was configured.
 *
 * {@link ApplicationAvailability} is bound unconditionally: the drain sequence flips readiness on every shutdown,
 * probes or not, and an application that never calls `.health()` still benefits from a shutdown that refuses
 * traffic before it stops listening.
 *
 * {@link HealthOptions} still resolves when `.health()` was never called — from the health schema's own defaults,
 * since an application that configured nothing placed nothing in its configuration either. Reaching the drain
 * policy from a file or the environment means calling `.health(h => h.config(c => c.app.health))`. The other
 * difference from the configured path is what `enabled` falls back to: here the Kubernetes auto-detection
 * decides, because nothing opted in.
 *
 * Always registered after the `HealthBuilder`, so a configured setup wins.
 */
export class HealthServiceConfigurer implements FeatureLifecycle {
  readonly #configured: boolean
  #resolved: ConfigSlice<HealthOptions> | undefined

  /**
   * @param configured - Whether a {@link HealthBuilder} is among the application's services. Passed in rather
   *   than probed for, because the question has to be answered while declaring — before any binding exists to
   *   check. Registering a second health slice when one is already there would derive the options twice, and
   *   `finalizeHealthOptions` emits its warnings from inside the derivation.
   */
  constructor(configured = false) {
    this.#configured = configured
  }

  get name(): string {
    return 'health'
  }

  beforeBootstrap(kit: BeforeBootstrapKit): void {
    if (this.#configured) {
      return
    }

    // Detached: no builder ran, so nothing named a location for these settings.
    const slice: ConfigSlice<HealthConfig> = defineFeatureConfig(kit.config, { schema: healthConfigSchema })
    this.#resolved = slice.derive(config => finalizeHealthOptions(mergeHealthConfig(config)))
  }

  bootstrap(kit: BootstrapKit): Promise<void> {
    if (!kit.container.has(ApplicationAvailability)) {
      // The application's own instance, not a container-constructed one: the lifecycle writes to that object, and
      // a second instance would report a state nothing ever updates.
      kit.container.bind(ApplicationAvailability, t => t.toValue(kit.availability).internal())
    }

    // Only ever set when no `HealthBuilder` is registered — `beforeBootstrap` returns early otherwise — so
    // this is the whole of "nobody configured health", with no need to ask whether the builder got there first.
    if (this.#resolved !== undefined) {
      kit.contributions.contribute(kHealthContribution, this.#resolved.config)
    }

    return Promise.resolve()
  }
}
