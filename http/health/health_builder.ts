import {
  type ServiceBeforeBootstrapIn,
  type Duration,
  type ShutdownSignal,
  type SignalDispatcher,
  Service,
  type ServiceAPI,
  type ServiceBootstrapIn,
} from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigLocation, type ConfigHandle, type ConfigSlice } from '@caffeinejs/std/config'

import { kHealthContribution } from './keys.js'
import {
  finalizeHealthOptions,
  healthConfigSchema,
  mergeHealthConfig,
  type HealthConfig,
  type HealthOptions,
  type HealthPaths,
} from './options.js'

/**
 * Configures the health feature: the probe endpoints, the drain policy, and the signals that trigger it. Bound via
 * `app.health()` — calling it with no configuration at all is a complete, correct setup.
 *
 * Calling `app.health()` **enables** the probes regardless of environment; leaving it uncalled enables them only
 * when `KUBERNETES_SERVICE_HOST` is present. An explicit `enabled` in the configuration always wins over both, so
 * `HEALTH__ENABLED=false` switches them off without a code change.
 *
 * There is one read path. A builder method does not hold its value here — it writes into the configuration tree
 * in the `CODE` band, and the feature reads the merged result. So `h.drainDelay('10s')` is a **default**:
 * `HEALTH__DRAINDELAY=30s` or `--health.drainDelay=30s` overrides it.
 *
 * The exception is {@link dispatcher}: a function cannot live in a configuration tree, so it stays on the
 * builder and is merged in afterwards. Health indicators are not configured here — they are container-managed
 * beans discovered through `HealthIndicator`.
 *
 * A {@link Service}: its `bootstrap` contributes {@link HealthOptions} under {@link kHealthContribution}. The
 * contributed object is live, like every other configuration in the framework — the probe budgets and the
 * response-shaping flags are read per request, so a refresh reaches them. The fields consumed once at boot, the
 * probe routes and the installed signals, simply stop mattering afterwards: nothing re-registers a route because
 * a value moved underneath it.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class HealthBuilder<C = unknown> implements Service {
  readonly #config: HealthConfig = {}
  #dispatcher: SignalDispatcher | undefined
  #selector: ((c: ConfigHandle<C>) => ConfigLocation<HealthConfig>) | undefined
  #options: ConfigSlice<HealthOptions> | undefined

  get name(): string {
    return 'health'
  }

  /** Forces the probes on or off, overriding the Kubernetes auto-detection. */
  enabled(enabled: boolean = true): ServiceAPI<this> {
    this.#config.enabled = enabled
    return this
  }

  /** Overrides one or more probe paths. Defaults: `/livez`, `/readyz`, `/startupz`. */
  paths(paths: Partial<HealthPaths>): ServiceAPI<this> {
    this.#config.paths = { ...this.#config.paths, ...paths }
    return this
  }

  /**
   * How long to keep serving after readiness starts refusing, before the server closes. Covers the orchestrator's
   * routing-table propagation lag; traffic still arrives during this window and is answered normally.
   */
  drainDelay(delay: Duration): ServiceAPI<this> {
    this.#config.drainDelay = delay
    return this
  }

  /** The budget for in-flight requests to finish once the server is closing. */
  shutdownTimeout(timeout: Duration): ServiceAPI<this> {
    this.#config.shutdownTimeout = timeout
    return this
  }

  /**
   * The pod's `terminationGracePeriodSeconds`. It cannot be read from inside the pod, so it must be mirrored here
   * (or injected through the downward API) for the boot-time budget check to mean anything.
   */
  terminationGracePeriod(period: Duration): ServiceAPI<this> {
    this.#config.terminationGracePeriod = period
    return this
  }

  /** Per-indicator budget. An indicator exceeding it is aborted and reported down. */
  indicatorTimeout(timeout: Duration): ServiceAPI<this> {
    this.#config.indicatorTimeout = timeout
    return this
  }

  /** Whole-probe budget, regardless of indicator count. */
  probeDeadline(deadline: Duration): ServiceAPI<this> {
    this.#config.probeDeadline = deadline
    return this
  }

  /** How long an evaluation is reused. Bounds the load the probes place on the dependencies they check. */
  cacheTTL(ttl: Duration): ServiceAPI<this> {
    this.#config.cacheTTL = ttl
    return this
  }

  /** Allows `?verbose` to expand the response body. Off by default: the body names your dependencies. */
  verbose(verbose: boolean = true): ServiceAPI<this> {
    this.#config.verbose = verbose
    return this
  }

  /** Allows `?exclude=<name>` to skip an indicator. Off by default: it lets a caller make readiness lie. */
  exclude(exclude: boolean = true): ServiceAPI<this> {
    this.#config.exclude = exclude
    return this
  }

  /** The signals that trigger a graceful shutdown, or `false` to install no handlers. */
  signals(signals: readonly ShutdownSignal[] | false): ServiceAPI<this> {
    this.#config.signals = signals === false ? false : [...signals]
    return this
  }

  /**
   * Replaces the {@link SignalDispatcher} that delivers signals and diagnostics. The host runtime's is detected
   * automatically and covers Node, Bun and Deno; supply one to bridge a runtime with native signal handling of its
   * own, or to observe the shutdown in a test.
   *
   * Not configuration — a function cannot live in a configuration tree — so this one is code-only.
   */
  dispatcher(dispatcher: SignalDispatcher): ServiceAPI<this> {
    this.#dispatcher = dispatcher
    return this
  }

  /**
   * Places the health settings elsewhere in the configuration tree, e.g. `h.config(c => c.app.health)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   * Both the reads and the defaults written by the builder methods follow it.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigLocation<HealthConfig>): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    const slice: ConfigSlice<HealthConfig> = defineFeatureConfig(kit.config, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: healthConfigSchema,
      values: { ...this.#config },
    })
    const dispatcher = this.#dispatcher

    // Reaching the builder at all is an explicit opt-in, so the Kubernetes auto-detection no longer decides.
    this.#options = slice.derive(config =>
      finalizeHealthOptions(mergeHealthConfig(config, { dispatcher, enabledDefault: true })),
    )
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    // The derived slice's own object: it is live, so the probe budgets and the response-shaping flags —
    // which are read per request — follow a refresh. The fields consumed once at boot, the probe routes and
    // the installed signals, simply stop mattering afterwards; nothing re-registers a route because a value
    // changed underneath it.
    kit.contributions.contribute(kHealthContribution, this.#options!.config)

    return Promise.resolve()
  }
}
