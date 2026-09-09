import type { ConfigSlice } from '../config/slice.js'
import type { Duration } from '../duration/index.js'
import { type BootstrapKit, kFeatureName } from '../feature.js'
import { FeatureBuilder } from '../feature_builder.js'
import {
  type ShutdownConfig,
  type ShutdownOptions,
  finalizeShutdownOptions,
  kShutdownPolicy,
  mergeShutdownConfig,
  shutdownConfigSchema,
} from './shutdown_options.js'
import type { ShutdownSignal, SignalDispatcher } from './signals.js'

/**
 * Configures graceful shutdown: the drain delay, the teardown budget, the signals that trigger it, and the
 * dispatcher that delivers them.
 *
 * Registered by every application, so the drain sequence exists whether or not `.shutdown()` was called. There
 * is one read path: a fluent method does not hold its value, it writes into the configuration tree in the
 * `CODE` band, and the feature reads the merged result. So `s.drainDelay('5s')` is a **default** —
 * `SHUTDOWN__DRAIN_DELAY=30s` or `--shutdown.drainDelay=30s` overrides it.
 *
 * The exception is {@link dispatcher}: a function cannot live in a configuration tree, so it stays on the
 * builder and is merged in afterwards.
 *
 * The resolved {@link ShutdownOptions} are published under {@link kShutdownPolicy}; the application reads them
 * once the container has initialized.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class ShutdownBuilder<C = unknown> extends FeatureBuilder<ShutdownConfig, C> {
  readonly [kFeatureName] = 'shutdown'

  protected readonly schema = shutdownConfigSchema

  #dispatcher: SignalDispatcher | undefined
  #options: ConfigSlice<ShutdownOptions> | undefined

  /**
   * How long to keep serving after availability starts refusing, before anything is torn down. Covers the
   * orchestrator's routing-table propagation lag; traffic still arrives during this window and is answered
   * normally.
   */
  drainDelay(delay: Duration): this {
    return this.set('drainDelay', delay)
  }

  /** The budget for in-flight work to finish once teardown starts. */
  shutdownTimeout(timeout: Duration): this {
    return this.set('shutdownTimeout', timeout)
  }

  /**
   * The pod's `terminationGracePeriodSeconds`. It cannot be read from inside the pod, so it must be mirrored
   * here (or injected through the downward API) for the boot-time budget check to mean anything.
   */
  terminationGracePeriod(period: Duration): this {
    return this.set('terminationGracePeriod', period)
  }

  /** The signals that trigger a graceful shutdown, or `false` to install no handlers. */
  signals(signals: readonly ShutdownSignal[] | false): this {
    return this.set('signals', signals === false ? false : [...signals])
  }

  /**
   * Replaces the {@link SignalDispatcher} that delivers signals and diagnostics. The host runtime's is detected
   * automatically and covers Node, Bun and Deno; supply one to bridge a runtime with native signal handling of
   * its own, or to observe the shutdown in a test.
   *
   * Not configuration — a function cannot live in a configuration tree — so this one is code-only.
   */
  dispatcher(dispatcher: SignalDispatcher): this {
    this.#dispatcher = dispatcher
    return this
  }

  protected override beforeBootstrap(): void {
    const dispatcher = this.#dispatcher
    this.#options = this.derive(config => finalizeShutdownOptions(mergeShutdownConfig(config, { dispatcher })))
  }

  protected bootstrap(kit: BootstrapKit): Promise<void> {
    // The derived slice's own object: it is live, so a refresh reaches the drain and teardown budgets.
    kit.container.bind(kShutdownPolicy, t => t.toValue(this.#options!.config).internal())
    return Promise.resolve()
  }
}
