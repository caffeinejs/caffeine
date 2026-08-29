import type { Container, ContainerBindingOps } from '@caffeinejs/di'
import type { ConfigDefinition } from './config/index.js'
import type { ApplicationAvailability } from './health/availability.js'

/**
 * What a {@link Service} may touch while declaring: the configuration definition, and nothing else.
 *
 * Deliberately narrow. There is no container here, so "a declare step registers configuration and binds
 * nothing" is enforced by the type rather than left to a comment — and a feature cannot accidentally depend
 * on a binding order that does not exist yet.
 */
export interface ServiceBeforeBootstrapIn {
  /**
   * The live configuration definition: where a feature writes its defaults and registers its slice.
   */
  config: ConfigDefinition

  /**
   * IoC container exposing only binding operations.
   */
  container: ContainerBindingOps
}

/**
 * The runtime kit handed to a {@link Service} when the application configures it, after configuration has
 * resolved and before the container is initialized. The base kit exposes the {@link Container} and the
 * application's {@link ApplicationAvailability}; concrete applications may extend it with platform-specific
 * handles (e.g. the HTTP app adds feature flags).
 */
export interface ServiceBootstrapIn {
  /**
   * IoC container exposing all its operations.
   */
  container: Container

  /**
   * The live configuration definition: where a feature writes its defaults and registers its slice.
   */
  config: ConfigDefinition

  /**
   * The application's availability. Bind this instance rather than letting the container construct one — the
   * lifecycle writes to the application's, and a second instance would report a state nothing ever updates.
   */
  availability: ApplicationAvailability
}

export interface Service {
  /**
   * Stable identifier for this service, used in logs and diagnostics.
   */
  get name(): string

  /**
   * Runs before configuration resolves. Register slices and defaults here; resolved values are not available yet.
   */
  beforeBootstrap?(kit: ServiceBeforeBootstrapIn): void | Promise<void>

  /**
   * Runs after configuration resolves and before the container initializes. Bind runtime artifacts here.
   */
  bootstrap(kit: ServiceBootstrapIn): Promise<void>
}

/**
 * The fluent configuration surface of a {@link Service}, with the lifecycle hooks omitted so they do not
 * appear in autocomplete on `.server(s => ...)`, `.kafka(k => ...)`, and similar.
 */
export type ServiceAPI<T extends Service> = Omit<T, keyof Service>
