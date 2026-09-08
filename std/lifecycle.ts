import type { Container, ContainerBindingOps } from '@caffeinejs/di'

import type { ConfigDefinition } from './config/index.js'
import type { ExtensionRegistrar } from './extensions.js'
import type { ApplicationAvailability } from './health/availability.js'

/**
 * What a feature may touch while declaring: the configuration definition, and nothing else.
 *
 * Deliberately narrow. There is no container here, so "a declare step registers configuration and binds
 * nothing" is enforced by the type rather than left to a comment — and a feature cannot accidentally depend
 * on a binding order that does not exist yet.
 */
export interface BeforeBootstrapKit {
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
 * The runtime kit handed to a feature when the application bootstraps it, after configuration has resolved
 * and before the container is initialized. The base kit exposes the {@link Container} and the application's
 * {@link ApplicationAvailability}; concrete applications may extend it with platform-specific handles.
 */
export interface BootstrapKit {
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

  /**
   * Where a feature registers an extension it has bound. What it adds runs in the order the application's
   * features were installed, not in the order their bootstrap hooks happened to reach this call.
   */
  extensions: ExtensionRegistrar
}

/**
 * The keys a feature's lifecycle hangs off. Symbols so the lifecycle stays off the builder's autocomplete:
 * `.extend(StaticExt, s => …)` sees the fluent surface and nothing else.
 */
export const kFeatureName = Symbol('caffeine.feature.name')
export const kBeforeBootstrap = Symbol('caffeine.feature.beforeBootstrap')
export const kBootstrap = Symbol('caffeine.feature.bootstrap')

/**
 * The unit the application orchestrator drives: it is bootstrapped once, in two phases, and never seen by
 * user code. A feature's fluent builder implements this directly — the authoring methods and the lifecycle
 * live on one object, kept apart by the symbol keys.
 */
export interface FeatureLifecycle {
  /**
   * Stable identifier for this feature, used in logs and diagnostics.
   */
  readonly [kFeatureName]: string

  /**
   * Runs before configuration resolves. Register slices and defaults here; resolved values are not available yet.
   */
  [kBeforeBootstrap]?(kit: BeforeBootstrapKit): void | Promise<void>

  /**
   * Runs after configuration resolves and before the container initializes. Bind runtime artifacts here.
   */
  [kBootstrap](kit: BootstrapKit): Promise<void>
}
