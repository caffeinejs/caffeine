import type { Container } from '@caffeinejs/di'

import type { ConfigHandle } from './config/index.js'
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
 * What a feature is handed when the application bootstraps it, after configuration has resolved and before
 * the container is initialized. Concrete applications may widen it with platform-specific handles.
 */
export interface BootstrapKit<C = unknown> {
  /**
   * IoC container exposing all its operations.
   */
  container: Container

  /**
   * The resolved application configuration. Live: its nodes read through the current tree, so a value taken
   * from a node rather than copied out of it follows a refresh.
   *
   * A feature sees `C` as `unknown` here and cannot usefully navigate it. The typed path is the second
   * argument of the configure callback the application wrote, which is this same handle.
   */
  config: ConfigHandle<C>

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
 * `.extend(staticFiles(s => …))` sees the fluent surface and nothing else.
 */
export const kFeatureName = Symbol('caffeine.feature.name')
export const kBootstrap = Symbol('caffeine.feature.bootstrap')

/**
 * The unit the application orchestrator drives: bootstrapped once, never seen by user code. A feature's
 * fluent builder implements this directly — the authoring methods and the lifecycle live on one object, kept
 * apart by the symbol keys.
 *
 * `C` is the application configuration type, which reaches a feature through {@link BootstrapKit.config}.
 */
export interface Feature<C = unknown> {
  /**
   * Stable identifier for this feature. It is the identity `.extend` deduplicates on, so a feature accepting
   * an instance name folds it in (`kafka` vs `kafka:orders`) and one image cannot install the same instance
   * twice.
   */
  get [kFeatureName](): string

  /**
   * Runs after configuration resolves and before the container initializes. Bind runtime artifacts and
   * register extensions here.
   */
  [kBootstrap](kit: BootstrapKit<C>): void | Promise<void>
}

/** Thrown when `.extend` installs a feature whose {@link kFeatureName} is already installed. */
export class ErrFeatureAlreadyInstalled extends ErrCaffeine {
  constructor(feature: string) {
    super(`Cannot install feature "${feature}": it is already installed`, 'ERR_FEATURE_ALREADY_INSTALLED')
  }
}
