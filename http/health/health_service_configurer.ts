import { ApplicationAvailability, kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ServiceKit } from '../service.js'
import { kHealthOptions } from './keys.js'
import { type HealthOptions, defaultHealthOptions, emitHealthWarnings, validateHealthOptions } from './options.js'

/**
 * Binds what the health feature needs whether or not it was configured.
 *
 * {@link ApplicationAvailability} is bound unconditionally: the drain sequence flips readiness on every shutdown,
 * probes or not, and an application that never calls `.health()` still benefits from a shutdown that refuses
 * traffic before it stops listening.
 *
 * {@link HealthOptions} falls back to {@link defaultHealthOptions}, which enables the probes only when
 * `KUBERNETES_SERVICE_HOST` is present. Always registered after the `HealthBuilder`, so a configured setup wins.
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
      const validated = validateHealthOptions(defaultHealthOptions())
      emitHealthWarnings(validated.warnings)

      kit.container
        .bind<HealthOptions>(kHealthOptions)
        .toValue(validated.options)
        .internal()
    }

    return Promise.resolve()
  }
}
