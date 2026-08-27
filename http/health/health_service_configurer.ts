import { ApplicationAvailability, type DeclareKit, type Service } from '@caffeinejs/std'
import type { ConfigSlice } from '@caffeinejs/std/config'
import type { ServiceKit } from '../service.js'
import { kHealthOptions } from './keys.js'
import {
  HEALTH_CONFIG_NAMESPACE,
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
 * {@link HealthOptions} still resolves from the configuration tree when `.health()` was never called, so the drain
 * policy can be set entirely from the environment — `HEALTH__DRAINDELAY=10s` works with no code change at all.
 * The only difference from the configured path is what `enabled` falls back to: here the Kubernetes
 * auto-detection decides, because nothing opted in.
 *
 * Always registered after the `HealthBuilder`, so a configured setup wins.
 */
export class HealthServiceConfigurer implements Service {
  readonly #configured: boolean
  #options: ConfigSlice<HealthOptions> | undefined

  /**
   * @param configured - Whether a {@link HealthBuilder} is among the application's services. Passed in rather
   *   than probed for, because the question has to be answered while declaring — before any binding exists to
   *   check. Registering a second health slice when one is already there would derive the options twice, and
   *   `finalizeHealthOptions` emits its warnings from inside the derivation.
   */
  constructor(configured = false) {
    this.#configured = configured
  }

  declare(kit: DeclareKit): void {
    if (this.#configured) {
      return
    }

    const slice: ConfigSlice<HealthConfig> = kit.config.slice(HEALTH_CONFIG_NAMESPACE, healthConfigSchema)
    this.#options = slice.derive(config => finalizeHealthOptions(mergeHealthConfig(config)))
  }

  configure(kit: ServiceKit): Promise<void> {
    if (!kit.container.has(ApplicationAvailability)) {
      // The application's own instance, not a container-constructed one: the lifecycle writes to that object, and
      // a second instance would report a state nothing ever updates.
      kit.container.bind(ApplicationAvailability)
        .toValue(kit.availability)
        .internal()
    }

    if (this.#options !== undefined && !kit.container.has(kHealthOptions)) {
      kit.container
        .bind<HealthOptions>(kHealthOptions)
        .toValue(this.#options.config)
        .internal()
    }

    return Promise.resolve()
  }
}
