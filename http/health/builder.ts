import { FeatureBuilder, kFeatureName, type FeatureConfigureKit } from '@caffeinejs/std'
import { type Duration } from '@caffeinejs/std/duration'
import { kHealthRegistryOptions } from '@caffeinejs/std/health'

import { solutions } from '../error/util.js'
import { ErrHealthConfiguration } from './errors.js'
import { mergeHealthConfig, type HealthConfig, type HealthOptions } from './options.js'

/**
 * Fluently builds the budgets `Health()` binds once, when it configures.
 *
 * What a fluent method sets is final. To let the environment redirect a budget, read it from the
 * configuration; {@link healthConfigSchema} is exported so an application can splice it into its own schema:
 *
 * ```ts
 * .install(Health((h, { config }) => h.config(config.app.health)))
 * ```
 *
 * Health indicators are not configured here — they are container-managed beans discovered through
 * `HealthIndicator`. Neither are the probe routes: those are `healthProbes()`, a server plugin.
 */
export class HealthBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'health'

  #config: Partial<HealthConfig> | undefined
  readonly #values: HealthConfig = {}

  /**
   * Reads the budgets from a node of the configuration tree, e.g. `config.app.health` — the same node
   * `healthProbes(p => p.config(...))` reads its probe settings from. The node is read once, when the feature
   * configures. A fluent method called alongside this one wins over what the node carries.
   */
  config(config: Partial<HealthConfig>): this {
    this.#config = config
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

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const options = mergeHealthConfig(this.#inputs())
    assertBudgets(options)

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

  /** What a fluent method set, else what the configuration node carries. Only the budgets: the rest is the probes'. */
  #inputs(): HealthConfig {
    return {
      indicatorTimeout: this.#values.indicatorTimeout ?? this.#config?.indicatorTimeout,
      probeDeadline: this.#values.probeDeadline ?? this.#config?.probeDeadline,
      cacheTtl: this.#values.cacheTtl ?? this.#config?.cacheTtl,
    }
  }
}

// A budget of 0 aborts every indicator that awaits on the next turn: readiness would fail for the life of the
// process, with nothing said at start-up.
function assertBudgets(options: HealthOptions): void {
  const { indicatorTimeoutMs, probeDeadlineMs } = options

  if (!(indicatorTimeoutMs > 0)) {
    throw new ErrHealthConfiguration(
      `Cannot configure health: an indicator timeout of "${indicatorTimeoutMs}ms" cancels every indicator that awaits` +
        solutions("Set a budget above 0, such as '2s'"),
    )
  }

  if (!(probeDeadlineMs > 0)) {
    throw new ErrHealthConfiguration(
      `Cannot configure health: a probe deadline of "${probeDeadlineMs}ms" cancels every indicator that awaits` +
        solutions("Set a budget above 0, such as '3s'"),
    )
  }
}
