import type { Container, ContainerBindingOps } from '@caffeinejs/di'

import type { ConfigDefinition } from './config/index.js'
import { ErrCaffeine } from './error.js'
import type { ApplicationAvailability } from './health/availability.js'

/**
 * Where a feature hands the platform a unit of start-up wiring.
 *
 * What the platform does with `extension` is the platform's business — the HTTP application takes a Fastify
 * plugin and registers it. A headless application takes nothing, so its registrar is a no-op and a feature
 * that contributes one is simply inert there.
 */
export interface ExtensionRegistrar<E = unknown> {
  /**
   * Contributes one extension. What is registered runs in the order the application's features were
   * installed, not in the order their bootstrap hooks happened to reach this call — features bootstrap
   * concurrently, so an `await` before this does not move it.
   */
  register(extension: E): void
}

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

  /** Where a feature contributes start-up wiring the platform runs. */
  extensions: ExtensionRegistrar
}

/**
 * The keys a feature's lifecycle hangs off. Symbols so the lifecycle stays off the builder's autocomplete:
 * `.extend(staticFiles(), s => …)` sees the fluent surface and nothing else.
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
  [kBootstrap](kit: BootstrapKit): void | Promise<void>
}

/**
 * Runtime seam handed to a feature at install time. A feature registers its {@link FeatureLifecycle} via
 * {@link addFeature} — its builder, which implements the lifecycle directly, so it rides the same bootstrap
 * path as the built-in features. It may also read the DI {@link container}.
 *
 * {@link state} is per application builder. A feature const must not keep install flags on itself —
 * two `createApplication()` calls in one process would share them.
 */
export interface PluginContext {
  addFeature(feature: FeatureLifecycle): void
  readonly container: Container
  readonly state: Map<string, unknown>
}

/**
 * A feature installed with `.extend(feature, configure?)`. A package's factory function returns one:
 * `cors()`, `kafka()`, `kafka('orders')`. `B` is the builder handed to `configure`.
 *
 * {@link name} is the identity `.extend` deduplicates on. A feature that accepts an instance name folds it
 * into `name` (`kafka` vs `kafka:orders`), so one image cannot install the same instance twice.
 */
export interface Feature<B = unknown> {
  readonly name: string
  install(ctx: PluginContext, configure?: (builder: B) => void): void
}

/**
 * Builds a {@link Feature} that constructs one builder, runs `configure` against it, and registers it.
 *
 * The shape every simple feature takes. A feature that needs more at install time — a shared lifecycle
 * listener, a lazily created provider, an instance name — writes its own function returning a {@link Feature}.
 *
 * ```ts
 * export const cors = (): Feature<CorsBuilder> => feature('cors', () => new CorsBuilder())
 * ```
 */
export function feature<B extends FeatureLifecycle>(name: string, create: () => B): Feature<B> {
  return {
    name,
    install(ctx, configure) {
      const builder = create()
      configure?.(builder)
      ctx.addFeature(builder)
    },
  }
}

/** Thrown when `.extend` installs a feature whose {@link Feature.name} is already installed. */
export class ErrFeatureAlreadyInstalled extends ErrCaffeine {
  constructor(feature: string) {
    super(`Cannot install feature "${feature}": it is already installed`, 'ERR_FEATURE_ALREADY_INSTALLED')
  }
}
