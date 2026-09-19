import type { Duration } from '../duration/index.js'
import { type FeatureConfigureKit, kFeatureName } from '../feature.js'
import { FeatureBuilder } from '../feature_builder.js'
import {
  type ShutdownConfig,
  finalizeShutdownOptions,
  kShutdownPolicy,
  mergeShutdownConfig,
} from './shutdown_options.js'
import type { ShutdownSignal, SignalDispatcher } from './signals.js'

/**
 * Configures graceful shutdown: the drain delay, the teardown budget, the signals that trigger it, and the
 * dispatcher that delivers them.
 *
 * Registered by every application, so the drain sequence exists whether or not `.shutdown()` was called. What a
 * fluent method sets is final; to let the environment redirect it, read the setting from the configuration:
 *
 * ```ts
 * .shutdown((s, c) => s.config(c.app.shutdown).dispatcher(myDispatcher))
 * ```
 *
 * The resolved {@link ShutdownOptions} are bound under {@link kShutdownPolicy}; the application reads them once
 * the container has initialized. What is bound is read once, when the feature configures — a refresh afterward
 * does not reach the drain and teardown budgets.
 */
export class ShutdownBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'shutdown'

  #config: Partial<ShutdownConfig> | undefined
  #values: ShutdownConfig = {}
  #dispatcher: SignalDispatcher | undefined

  /**
   * Reads every setting from a node of the configuration tree, e.g. `c.app.shutdown`.
   *
   * The node is read once, when the feature configures. A fluent method called alongside this one wins over
   * what the node carries.
   */
  config(config: Partial<ShutdownConfig>): this {
    this.#config = config
    return this
  }

  /**
   * How long to keep serving after availability starts refusing, before anything is torn down. Covers the
   * orchestrator's routing-table propagation lag; traffic still arrives during this window and is answered
   * normally.
   */
  drainDelay(delay: Duration): this {
    this.#values.drainDelay = delay
    return this
  }

  /** The budget for in-flight work to finish once teardown starts. */
  shutdownTimeout(timeout: Duration): this {
    this.#values.shutdownTimeout = timeout
    return this
  }

  /**
   * The pod's `terminationGracePeriodSeconds`. It cannot be read from inside the pod, so it must be mirrored
   * here (or injected through the downward API) for the boot-time budget check to mean anything.
   */
  terminationGracePeriod(period: Duration): this {
    this.#values.terminationGracePeriod = period
    return this
  }

  /** The signals that trigger a graceful shutdown, or `false` to install no handlers. */
  signals(signals: readonly ShutdownSignal[] | false): this {
    this.#values.signals = signals === false ? false : [...signals]
    return this
  }

  /**
   * Replaces the {@link SignalDispatcher} that delivers signals and diagnostics. The host runtime's is detected
   * automatically and covers Node, Bun and Deno; supply one to bridge a runtime with native signal handling of
   * its own, or to observe the shutdown in a test.
   */
  dispatcher(dispatcher: SignalDispatcher): this {
    this.#dispatcher = dispatcher
    return this
  }

  protected configure(kit: FeatureConfigureKit<C>): void {
    // Validated here, at `ready()` while the logs are still being watched, rather than during the shutdown a
    // bad budget would ruin.
    const policy = finalizeShutdownOptions(mergeShutdownConfig(this.#inputs(), { dispatcher: this.#dispatcher }))

    kit.container.bind(kShutdownPolicy, t => t.toValue(policy).internal())
  }

  /** What a fluent method set, else what the configuration node carries. */
  #inputs(): ShutdownConfig {
    return {
      drainDelay: this.#values.drainDelay ?? this.#config?.drainDelay,
      shutdownTimeout: this.#values.shutdownTimeout ?? this.#config?.shutdownTimeout,
      terminationGracePeriod: this.#values.terminationGracePeriod ?? this.#config?.terminationGracePeriod,
      signals: this.#values.signals ?? this.#config?.signals,
    }
  }
}
