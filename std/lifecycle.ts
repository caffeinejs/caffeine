import type { Container, ContainerBindingOps } from '@caffeinejs/di'

import type { ConfigDefinition } from './config/index.js'
import type { Contributions } from './contributions.js'
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
   * Where a feature leaves what the application needs from it once everything is up. Write-only here: it is
   * sealed the moment every feature has bootstrapped, and reads before that throw.
   */
  contributions: Contributions
}

/**
 * The unit the application orchestrator drives: it is bootstrapped once, in two phases, and never seen by
 * user code. A feature's fluent builder is a separate object — {@link FeatureProvider} yields this from it.
 */
export interface FeatureLifecycle {
  /**
   * Stable identifier for this feature, used in logs and diagnostics.
   */
  readonly name: string

  /**
   * Runs before configuration resolves. Register slices and defaults here; resolved values are not available yet.
   */
  beforeBootstrap?(kit: BeforeBootstrapKit): void | Promise<void>

  /**
   * Runs after configuration resolves and before the container initializes. Bind runtime artifacts here.
   */
  bootstrap(kit: BootstrapKit): Promise<void>
}

/**
 * The key under which a fluent builder exposes its {@link FeatureLifecycle}. A symbol so the handoff stays
 * off the builder's autocomplete: `.extend(StaticExt, s => …)` sees the fluent surface and nothing else.
 */
export const kFeatureSetup = Symbol('caffeine.feature.setup')

/**
 * A fluent configuration builder that yields the lifecycle unit the application drives. The builder holds the
 * authored state; the returned {@link FeatureLifecycle} reads it.
 */
export interface FeatureProvider {
  [kFeatureSetup](): FeatureLifecycle
}
