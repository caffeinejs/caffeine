import {
  ApplicationAvailability,
  FeatureBuilder,
  kFeatureName,
  kShutdownPolicy,
  type BootstrapKit,
  type Duration,
  type ShutdownSignal,
  type SignalDispatcher,
} from '@caffeinejs/std'
import { type ConfigSlice } from '@caffeinejs/std/config'

import { ServerOwnedPaths } from '../server_owned_paths.js'
import { kHealthConfig } from './keys.js'
import { loadHealthIndicators } from './load.js'
import {
  finalizeHealthOptions,
  healthConfigSchema,
  mergeHealthConfig,
  type HealthConfig,
  type HealthOptions,
  type HealthPaths,
} from './options.js'
import { ProbeEndpoint } from './probes.js'
import { HealthProbesExtension } from './probes_extension.js'
import { HealthRegistry } from './registry.js'

/** The probe paths, declared so a fallback knows the server owns them. */
export class HealthOwnedPaths extends ServerOwnedPaths {
  readonly paths: readonly string[]

  constructor(paths: HealthPaths) {
    super()
    this.paths = Object.values(paths)
  }
}

/**
 * Configures the health feature: the probe endpoints, the drain policy, and the signals that trigger it.
 *
 * Registered by every HTTP application, so the probes and the drain policy exist whether or not `app.health()`
 * was called. Calling it **enables** the probes regardless of environment; leaving it uncalled enables them
 * only when `KUBERNETES_SERVICE_HOST` is present. An explicit `enabled` in the configuration always wins over
 * both, so `HEALTH__ENABLED=false` switches them off without a code change.
 *
 * There is one read path. A builder method does not hold its value here — it writes into the configuration
 * tree in the `CODE` band, and the feature reads the merged result. So `h.drainDelay('10s')` is a **default**:
 * `HEALTH__DRAINDELAY=30s` or `--health.drainDelay=30s` overrides it.
 *
 * The exception is {@link dispatcher}: a function cannot live in a configuration tree, so it stays on the
 * builder and is merged in afterwards. Health indicators are not configured here — they are container-managed
 * beans discovered through `HealthIndicator`.
 *
 * The resolved {@link HealthOptions} are published under {@link kHealthConfig}, and they are live like every
 * other configuration in the framework — the probe budgets and the response-shaping flags are read per
 * request, so a refresh reaches them. The fields consumed once at boot, the probe routes and the installed
 * signals, simply stop mattering afterwards: nothing re-registers a route because a value moved underneath it.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class HealthBuilder<C = unknown> extends FeatureBuilder<HealthConfig, C> {
  readonly [kFeatureName] = 'health'

  protected readonly schema = healthConfigSchema

  #dispatcher: SignalDispatcher | undefined
  #explicit = false
  #options: ConfigSlice<HealthOptions> | undefined

  /**
   * Records that the application asked for health, which is what makes the probes on by default.
   *
   * Called by the application builder when `app.health(...)` is reached. The feature is registered either way,
   * so this is the whole difference between a configured setup and the fallback one.
   */
  markExplicit(): this {
    this.#explicit = true
    return this
  }

  /** Forces the probes on or off, overriding the Kubernetes auto-detection. */
  enabled(enabled: boolean = true): this {
    return this.set('enabled', enabled)
  }

  /** Overrides one or more probe paths. Defaults: `/livez`, `/readyz`, `/startupz`. */
  paths(paths: Partial<HealthPaths>): this {
    return this.set('paths', { ...this.get('paths'), ...paths } as HealthPaths)
  }

  /**
   * How long to keep serving after readiness starts refusing, before the server closes. Covers the orchestrator's
   * routing-table propagation lag; traffic still arrives during this window and is answered normally.
   */
  drainDelay(delay: Duration): this {
    return this.set('drainDelay', delay)
  }

  /** The budget for in-flight requests to finish once the server is closing. */
  shutdownTimeout(timeout: Duration): this {
    return this.set('shutdownTimeout', timeout)
  }

  /**
   * The pod's `terminationGracePeriodSeconds`. It cannot be read from inside the pod, so it must be mirrored here
   * (or injected through the downward API) for the boot-time budget check to mean anything.
   */
  terminationGracePeriod(period: Duration): this {
    return this.set('terminationGracePeriod', period)
  }

  /** Per-indicator budget. An indicator exceeding it is aborted and reported down. */
  indicatorTimeout(timeout: Duration): this {
    return this.set('indicatorTimeout', timeout)
  }

  /** Whole-probe budget, regardless of indicator count. */
  probeDeadline(deadline: Duration): this {
    return this.set('probeDeadline', deadline)
  }

  /** How long an evaluation is reused. Bounds the load the probes place on the dependencies they check. */
  cacheTTL(ttl: Duration): this {
    return this.set('cacheTTL', ttl)
  }

  /** Allows `?verbose` to expand the response body. Off by default: the body names your dependencies. */
  verbose(verbose: boolean = true): this {
    return this.set('verbose', verbose)
  }

  /** Allows `?exclude=<name>` to skip an indicator. Off by default: it lets a caller make readiness lie. */
  exclude(exclude: boolean = true): this {
    return this.set('exclude', exclude)
  }

  /** The signals that trigger a graceful shutdown, or `false` to install no handlers. */
  signals(signals: readonly ShutdownSignal[] | false): this {
    return this.set('signals', signals === false ? false : [...signals])
  }

  /**
   * Replaces the {@link SignalDispatcher} that delivers signals and diagnostics. The host runtime's is detected
   * automatically and covers Node, Bun and Deno; supply one to bridge a runtime with native signal handling of its
   * own, or to observe the shutdown in a test.
   *
   * Not configuration — a function cannot live in a configuration tree — so this one is code-only.
   */
  dispatcher(dispatcher: SignalDispatcher): this {
    this.#dispatcher = dispatcher
    return this
  }

  protected override beforeBootstrap(): void {
    const dispatcher = this.#dispatcher
    // Reaching the builder at all is an explicit opt-in, so the Kubernetes auto-detection no longer decides.
    const enabledDefault = this.#explicit ? true : undefined

    this.#options = this.derive(
      config => finalizeHealthOptions(mergeHealthConfig(config, { dispatcher, enabledDefault })),
      kHealthConfig,
    )
  }

  protected bootstrap(kit: BootstrapKit): Promise<void> {
    // The derived slice's own object: it is live, so the probe budgets and the response-shaping flags — which
    // are read per request — follow a refresh.
    const options = this.#options!.config

    if (!kit.container.has(ApplicationAvailability)) {
      // The application's own instance, not a container-constructed one: the lifecycle writes to that object,
      // and a second instance would report a state nothing ever updates.
      kit.container.bind(ApplicationAvailability, t => t.toValue(kit.availability).internal())
    }

    // Both lazy: `loadHealthIndicators` resolves beans, which is only legal once the container has
    // initialized. The probes extension forces them during server setup, so an indicator with the wrong
    // lifetime is still a start-up failure.
    kit.container.bind(HealthRegistry, t =>
      t.toFactory(() => new HealthRegistry(loadHealthIndicators(kit.container), options)).internal(),
    )
    kit.container.bind(ProbeEndpoint, t =>
      t
        .toFunction(
          (registry: HealthRegistry) => new ProbeEndpoint(kit.availability, registry, options),
          [HealthRegistry],
        )
        .internal(),
    )

    // Owned whether or not the probes are mounted: a fallback must not start serving a shell at `/livez`
    // because health happened to be switched off in this environment.
    kit.container.bind(HealthOwnedPaths, t =>
      t.toValue(new HealthOwnedPaths(options.paths)).extends(ServerOwnedPaths).internal(),
    )

    // `.health(h => h.drainDelay('10s'))` is how an HTTP application states its drain, so this is where the
    // application's shutdown budget comes from.
    kit.container.bind(kShutdownPolicy, t =>
      t
        .toValue({
          drainDelayMs: options.drainDelayMs,
          shutdownTimeoutMs: options.shutdownTimeoutMs,
          signals: options.signals,
          dispatcher: options.dispatcher,
        })
        .internal(),
    )

    kit.extensions.register(HealthProbesExtension, new HealthProbesExtension(options))

    return Promise.resolve()
  }
}
