import { type FeatureConfigureKit, kFeatureName } from '@caffeinejs/std'
import { type Duration } from '@caffeinejs/std/duration'
import { ApplicationHealth, kHealthRegistryOptions } from '@caffeinejs/std/health'
import { isKubernetes } from '@caffeinejs/std/shutdown'
import type { FastifyInstance } from 'fastify'

import type { HTTPSetupContext } from '../adapter.js'
import { HTTPFeatureBuilder } from '../feature.js'
import { mergeHealthConfig, type HealthConfig, type HealthOptions, type HealthPaths } from './options.js'
import { installHealthProbes } from './probes_route.js'

/**
 * Fluently builds the {@link HealthOptions} `health()` resolves once, when it configures.
 *
 * What a fluent method sets is final. To let the environment redirect a budget, read it from the
 * configuration; {@link healthConfigSchema} is exported so an application can splice it into its own schema:
 *
 * ```ts
 * .with(health((h, { config }) => h.config(config.app.health)))
 * ```
 *
 * Health indicators are not configured here — they are container-managed beans discovered through
 * `HealthIndicator`.
 */
export class HealthBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
  readonly [kFeatureName] = 'health'

  #k8s = false
  #config: Partial<HealthConfig> | undefined
  readonly #values: HealthConfig = {}
  #options: HealthOptions | undefined

  /**
   * Reads every setting from a node of the configuration tree, e.g. `config.app.health`.
   *
   * The node is read once, when the feature configures. A fluent method called alongside this one wins over
   * what the node carries.
   */
  config(config: Partial<HealthConfig>): this {
    this.#config = config
    return this
  }

  /** Forces the probes on or off, overriding the Kubernetes auto-detection. */
  enabled(enabled: boolean = true): this {
    this.#values.enabled = enabled
    return this
  }

  /**
   * Opts into the Kubernetes auto-detection for the `enabled` default: on inside a pod
   * (`KUBERNETES_SERVICE_HOST` present), off elsewhere. Installing the feature at all already enables the
   * probes by default — call this only to gate that default on the environment instead.
   */
  k8s(): this {
    this.#k8s = true
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
    this.#values.cacheTtl = ttl
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

  /** Folds the fluent values and the configured block into {@link HealthOptions}. */
  resolve(): HealthOptions {
    // Installing the feature at all is the opt-in; `.k8s()` is what gates that default on the environment
    // instead. An explicit `enabled` — fluent or configured — always wins over both.
    const enabledDefault = this.#k8s ? isKubernetes() : true

    return mergeHealthConfig(this.#inputs(), { enabledDefault })
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const options = this.resolve()
    this.#options = options

    // Bound whether or not the probes are mounted: the budgets govern every caller of `ApplicationHealth`, so an
    // application polled by something other than HTTP — Watt, say — still tunes them here.
    kit.container.bind(kHealthRegistryOptions, t =>
      t
        .toValue({
          indicatorTimeoutMs: options.indicatorTimeoutMs,
          probeDeadlineMs: options.probeDeadlineMs,
          cacheTTLMs: options.cacheTTLMs,
        })
        .internal(),
    )
  }

  protected override server(instance: FastifyInstance, kit: HTTPSetupContext<C>): void {
    // Resolved before the `enabled` check: building the service is what rejects a non-singleton indicator, and
    // that belongs to start-up whether or not the probes are mounted.
    const health = kit.container.get(ApplicationHealth)
    const options = this.#options ?? this.resolve()

    if (options.enabled) {
      installHealthProbes(instance, options, health)
    }
  }

  /** What a fluent method set, else what the configuration node carries. */
  #inputs(): HealthConfig {
    return {
      enabled: this.#values.enabled ?? this.#config?.enabled,
      paths: { ...this.#config?.paths, ...this.#values.paths },
      indicatorTimeout: this.#values.indicatorTimeout ?? this.#config?.indicatorTimeout,
      probeDeadline: this.#values.probeDeadline ?? this.#config?.probeDeadline,
      cacheTtl: this.#values.cacheTtl ?? this.#config?.cacheTtl,
      verbose: this.#values.verbose ?? this.#config?.verbose,
      exclude: this.#values.exclude ?? this.#config?.exclude,
    }
  }
}
