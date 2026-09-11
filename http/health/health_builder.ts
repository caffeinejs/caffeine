import {
  ApplicationAvailability,
  FeatureBuilder,
  kFeatureName,
  type BootstrapKit,
  type Duration,
} from '@caffeinejs/std'
import { liveFold, type ConfigLocation } from '@caffeinejs/std/config'

import { registerPlugin } from '../plugin.js'
import { ServerOwnedPaths } from '../server_owned_paths.js'
import { kHealthOptions } from './keys.js'
import { loadHealthIndicators } from './load.js'
import { mergeHealthConfig, type HealthConfig, type HealthPaths } from './options.js'
import { ProbeEndpoint } from './probes.js'
import { healthProbesPlugin } from './probes_plugin.js'
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
 * Configures the health feature: the Kubernetes probe endpoints and their budgets. Graceful shutdown — the
 * drain policy and the signals that trigger it — is a separate feature, configured with `app.shutdown(...)`.
 *
 * Registered by every HTTP application, so the probes exist whether or not `app.health()` was called. Calling
 * it **enables** the probes regardless of environment; leaving it uncalled enables them only when
 * `KUBERNETES_SERVICE_HOST` is present. An explicit `enabled` — set here or read from the configuration —
 * always wins over both.
 *
 * What a fluent method sets is final. To let the environment redirect a budget, read it from the
 * configuration; {@link healthConfigSchema} is exported so an application can splice it into its own schema:
 *
 * ```ts
 * .health((h, c) => h.withConfig(c.app.health))
 * ```
 *
 * Health indicators are not configured here — they are container-managed beans discovered through
 * `HealthIndicator`.
 *
 * The resolved {@link HealthOptions} are bound under {@link kHealthOptions}, with a stable identity and folded
 * on read: the probe budgets and the response-shaping flags are read per request, so a node handed to
 * {@link withConfig} carries a refresh through to them. The probe routes, consumed once at boot, simply stop
 * mattering afterwards — nothing re-registers a route because a value moved underneath it.
 */
export class HealthBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'health'

  #explicit = false
  #config: ConfigLocation<HealthConfig> | undefined
  readonly #values: HealthConfig = {}

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

  /**
   * Reads every setting from a node of the configuration tree, e.g. `c.app.health`.
   *
   * The node is read, never copied, so a refresh reaches the budgets and the response-shaping flags. A fluent
   * method called alongside this one wins over what the node carries.
   */
  withConfig(config: ConfigLocation<HealthConfig>): this {
    this.#config = config
    return this
  }

  /** Forces the probes on or off, overriding the Kubernetes auto-detection. */
  enabled(enabled: boolean = true): this {
    this.#values.enabled = enabled
    return this
  }

  /** Overrides one or more probe paths. Defaults: `/livez`, `/readyz`, `/startupz`. */
  paths(paths: Partial<HealthPaths>): this {
    this.#values.paths = { ...this.#values.paths, ...paths }
    return this
  }

  /** Per-indicator budget. An indicator exceeding it is aborted and reported down. */
  indicatorTimeout(timeout: Duration): this {
    this.#values.indicatorTimeout = timeout
    return this
  }

  /** Whole-probe budget, regardless of indicator count. */
  probeDeadline(deadline: Duration): this {
    this.#values.probeDeadline = deadline
    return this
  }

  /** How long an evaluation is reused. Bounds the load the probes place on the dependencies they check. */
  cacheTTL(ttl: Duration): this {
    this.#values.cacheTTL = ttl
    return this
  }

  /** Allows `?verbose` to expand the response body. Off by default: the body names your dependencies. */
  verbose(verbose: boolean = true): this {
    this.#values.verbose = verbose
    return this
  }

  /** Allows `?exclude=<name>` to skip an indicator. Off by default: it lets a caller make readiness lie. */
  exclude(exclude: boolean = true): this {
    this.#values.exclude = exclude
    return this
  }

  protected bootstrap(kit: BootstrapKit<C>): void {
    // Reaching the builder at all is an explicit opt-in, so the Kubernetes auto-detection no longer decides.
    const enabledDefault = this.#explicit ? true : undefined

    // Live: the probe budgets and the response-shaping flags are read per request, so they follow a refresh.
    const options = liveFold(
      () => this.#inputs(),
      raw => mergeHealthConfig(raw, { enabledDefault }),
    )

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

    kit.container.bind(kHealthOptions, t => t.toValue(options).internal())

    registerPlugin(kit, healthProbesPlugin(options))
  }

  /** What a fluent method set, else what the configuration node carries. */
  #inputs(): HealthConfig {
    return {
      enabled: this.#values.enabled ?? this.#config?.enabled,
      paths: { ...this.#config?.paths, ...this.#values.paths },
      indicatorTimeout: this.#values.indicatorTimeout ?? this.#config?.indicatorTimeout,
      probeDeadline: this.#values.probeDeadline ?? this.#config?.probeDeadline,
      cacheTTL: this.#values.cacheTTL ?? this.#config?.cacheTTL,
      verbose: this.#values.verbose ?? this.#config?.verbose,
      exclude: this.#values.exclude ?? this.#config?.exclude,
    }
  }
}
