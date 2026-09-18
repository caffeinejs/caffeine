import type { ContainerBindingOps, ContainerOps } from '@caffeinejs/di'

import type { ConfigHandle } from './config/index.js'
import { ErrCaffeine } from './error.js'
import type { Logger } from './logger/logger.js'

/**
 * What a feature is handed when the application configures it: after configuration has resolved and before
 * the container is initialized, so binding is still open.
 */
export interface FeatureConfigureKit<C = unknown> {
  container: ContainerBindingOps
  config: ConfigHandle<C>
}

/**
 * What a feature is handed when the application bootstraps it, after the container is initialized.
 * Binding is closed; the container exposes lookup only.
 */
export interface BootstrapKit<C = unknown> {
  /**
   * IoC container exposing lookup operations. Binding is closed by this point.
   */
  container: ContainerOps

  /**
   * The resolved application configuration. Live: its nodes read through the current tree, so a value taken
   * from a node rather than copied out of it follows a refresh.
   *
   * A feature sees `C` as `unknown` here and cannot usefully navigate it. The typed path is the second
   * argument of the configure callback the application wrote, which is this same handle.
   */
  config: ConfigHandle<C>

  /** The application's logger, as the logger feature configured it. */
  logger: Logger
}

/**
 * The keys a feature's lifecycle hangs off. Symbols so the lifecycle stays off the builder's autocomplete:
 * `.with(staticFiles(s => …))` sees the fluent surface and nothing else.
 */
export const kFeatureName = Symbol('caffeine.feature.name')
export const kFeatureConfigure = Symbol('caffeine.feature.configure')
export const kFeatureBootstrap = Symbol('caffeine.feature.bootstrap')

/**
 * The unit the application orchestrator drives: configured then bootstrapped once, never seen by user code.
 * A feature's fluent builder implements this directly — the authoring methods and the lifecycle live on one
 * object, kept apart by the symbol keys.
 *
 * `C` is the application configuration type, which reaches a feature through {@link FeatureConfigureKit.config}
 * and {@link BootstrapKit.config}.
 */
export interface Feature<C = unknown> {
  /**
   * Stable identifier for this feature. It is the identity `.with` deduplicates on, so a feature accepting
   * an instance name folds it in (`kafka` vs `kafka:orders`) and one image cannot install the same instance
   * twice.
   */
  get [kFeatureName](): string

  /**
   * Runs after configuration resolves and before the container initializes. Bind runtime artifacts here.
   */
  [kFeatureConfigure](kit: FeatureConfigureKit<C>): void | Promise<void>

  /**
   * Runs after the container initializes. Look up bindings here.
   *
   * Features bootstrap concurrently, so nothing here may depend on another feature's bootstrap having run.
   */
  [kFeatureBootstrap]?(kit: BootstrapKit<C>): void | Promise<void>
}

/** Thrown when `.with` installs a feature whose {@link kFeatureName} is already installed. */
export class ErrFeatureAlreadyInstalled extends ErrCaffeine {
  constructor(feature: string) {
    super(`Cannot install feature "${feature}": it is already installed`, 'ERR_FEATURE_ALREADY_INSTALLED')
  }
}
