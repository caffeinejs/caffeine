import type { Container } from '@caffeinejs/di'

/**
 * The runtime kit handed to a {@link Service} when the application configures it, before the container is
 * initialized. The base kit exposes only the {@link Container}; concrete applications may extend it with
 * platform-specific handles (e.g. the HTTP app adds feature flags).
 */
export interface ServiceKit {
  container: Container
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
