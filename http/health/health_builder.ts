import {
  ApplicationAvailability,
  FeatureBuilder,
  kFeatureName,
  type BootstrapKit,
  type Duration,
} from '@caffeinejs/std'
import { type ConfigSlice } from '@caffeinejs/std/config'

import { ServerOwnedPaths } from '../server_owned_paths.js'
import { kHealthConfig } from './keys.js'
import { loadHealthIndicators } from './load.js'
import {
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
 * Configures the health feature: the Kubernetes probe endpoints and their budgets. Graceful shutdown — the
 * drain policy and the signals that trigger it — is a separate feature, configured with `app.shutdown(...)`.
 *
 * Registered by every HTTP application, so the probes exist whether or not `app.health()` was called. Calling
 * it **enables** the probes regardless of environment; leaving it uncalled enables them only when
 * `KUBERNETES_SERVICE_HOST` is present. An explicit `enabled` in the configuration always wins over both, so
 * `HEALTH__ENABLED=false` switches them off without a code change.
 *
 * There is one read path. A builder method does not hold its value here — it writes into the configuration
 * tree in the `CODE` band, and the feature reads the merged result. So `h.cacheTTL('10s')` is a **default**:
 * `HEALTH__CACHE_TTL=30s` or `--health.cacheTTL=30s` overrides it.
 *
 * Health indicators are not configured here — they are container-managed beans discovered through
 * `HealthIndicator`.
 *
 * The resolved {@link HealthOptions} are published under {@link kHealthConfig}, and they are live like every
 * other configuration in the framework — the probe budgets and the response-shaping flags are read per
 * request, so a refresh reaches them. The probe routes, consumed once at boot, simply stop mattering
 * afterwards: nothing re-registers a route because a value moved underneath it.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class HealthBuilder<C = unknown> extends FeatureBuilder<HealthConfig, C> {
  readonly [kFeatureName] = 'health'

  protected readonly schema = healthConfigSchema

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

  protected override beforeBootstrap(): void {
    // Reaching the builder at all is an explicit opt-in, so the Kubernetes auto-detection no longer decides.
    const enabledDefault = this.#explicit ? true : undefined

    this.#options = this.derive(config => mergeHealthConfig(config, { enabledDefault }), kHealthConfig)
  }

  protected bootstrap(kit: BootstrapKit): void {
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

    kit.extensions.register(HealthProbesExtension, new HealthProbesExtension(options))
  }
}
