import { ApplicationHealth } from '@caffeinejs/std/health'
import { isKubernetes } from '@caffeinejs/std/shutdown'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import type { HTTPPluginConfigurer, HTTPPluginFactory } from '../plugin.js'
import { mergeHealthConfig, type HealthConfig, type HealthOptions, type HealthPaths } from './options.js'
import { installHealthProbes } from './probes_route.js'

/**
 * Fluently builds what `healthProbes()` mounts: whether, where, and how the probes answer.
 *
 * What a fluent method sets is final. To let the environment redirect a setting, declare a block of
 * {@link HealthConfig} in the application's schema and hand its node to {@link config}.
 * The budgets the probes answer under are not configured here — they are the health feature's,
 * `.install(Health(...))`.
 */
export class HealthProbesBuilder {
  #k8s = false
  #config: Partial<HealthConfig> | undefined
  readonly #values: HealthConfig = {}

  /**
   * Reads the probe settings from a node of the configuration tree, e.g. `config.app.health` — the same node
   * `Health(h => h.config(...))` reads its budgets from. The node is read once, when the plugin is built. A
   * fluent method called alongside this one wins over what the node carries.
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
   * (`KUBERNETES_SERVICE_HOST` present), off elsewhere. Registering the plugin at all already enables the
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
    // Registering the plugin at all is the opt-in; `.k8s()` is what gates that default on the environment
    // instead. An explicit `enabled` — fluent or configured — always wins over both.
    const enabledDefault = this.#k8s ? isKubernetes() : true

    return mergeHealthConfig(this.#inputs(), { enabledDefault })
  }

  /** What a fluent method set, else what the configuration node carries. The budget keys are the feature's. */
  #inputs(): HealthConfig {
    return {
      enabled: this.#values.enabled ?? this.#config?.enabled,
      paths: { ...this.#config?.paths, ...this.#values.paths },
      verbose: this.#values.verbose ?? this.#config?.verbose,
      exclude: this.#values.exclude ?? this.#config?.exclude,
    }
  }
}

/**
 * The Kubernetes probes (`/livez`, `/readyz`, `/startupz`), answering from the application's
 * `ApplicationHealth`: `.with(healthProbes())`.
 *
 * Registering it is the opt-in for the routes — on by default from there, unless `.k8s()` gates that default
 * on `KUBERNETES_SERVICE_HOST`, or `.enabled(false)` / a configured `enabled` turns them off outright. The
 * budgets the probes answer under are the health feature's — `.install(Health(...))` — or the defaults when
 * it was never installed.
 */
export function healthProbes<C = unknown>(
  configure?: HTTPPluginConfigurer<HealthProbesBuilder, C>,
): HTTPPluginFactory<C> {
  return context => {
    const builder = new HealthProbesBuilder()
    configure?.(builder, context)

    const options = builder.resolve()

    return fp(
      async (instance: FastifyInstance) => {
        // Resolved before the `enabled` check: building the service is what rejects a non-singleton indicator,
        // and that belongs to start-up whether or not the probes are mounted.
        const health = context.container.get(ApplicationHealth)

        if (options.enabled) {
          installHealthProbes(instance, options, health)
        }
      },
      { name: 'caffeine-health-probes' },
    )
  }
}
