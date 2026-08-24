import type { Container } from '@caffeinejs/di'
import type { ApplicationAvailability } from './health/availability.js'

/**
 * The runtime kit handed to a {@link Service} when the application configures it, before the container is
 * initialized. The base kit exposes the {@link Container} and the application's {@link ApplicationAvailability};
 * concrete applications may extend it with platform-specific handles (e.g. the HTTP app adds feature flags).
 */
export interface ServiceKit {
  container: Container
  /**
   * The application's availability. Bind this instance rather than letting the container construct one — the
   * lifecycle writes to the application's, and a second instance would report a state nothing ever updates.
   */
  availability: ApplicationAvailability
}

/** Symbol-keyed configuration hook a {@link Service} implements. */
export const kServiceConfigure = Symbol('configure')

/**
 * A unit of application configuration that binds values into the container at `ready()` time, before
 * `container.init()`. Builders (auth, cache, view, ...) and plugin-contributed configurers implement it.
 */
export interface Service {
  [kServiceConfigure](kit: ServiceKit): Promise<void>
}
