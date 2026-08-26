import { ApplicationAvailability, kServiceConfigure, type Service } from '@caffeinejs/std'
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
  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (!kit.container.has(ApplicationAvailability)) {
      // The application's own instance, not a container-constructed one: the lifecycle writes to that object, and
      // a second instance would report a state nothing ever updates.
      kit.container.bind(ApplicationAvailability)
        .toValue(kit.availability)
        .internal()
    }

    if (!kit.container.has(kHealthOptions)) {
      const slice: ConfigSlice<HealthConfig> = kit.config.slice(HEALTH_CONFIG_NAMESPACE, healthConfigSchema)
      const options = slice.derive(config => finalizeHealthOptions(mergeHealthConfig(config)))

      kit.container
        .bind<HealthOptions>(kHealthOptions)
        .toFactory(() => options.config)
        .internal()
    }

    return Promise.resolve()
  }
}
