import {
  ArgsConfigProvider,
  ConfigPriority,
  type ArgsConfigProviderOptions,
  type ConfigDefinition,
  type ConfigPriorityValue,
  type ConfigProvider,
  type ResolutionContext,
} from './config/index.js'

/**
 * The well-known token the base `.config()` builder binds the application {@link ConfigHandle} under.
 * Features resolve it to read their configuration slice (e.g. `.server(s => s.config(c => c.server))`).
 */
export const kAppConfig = Symbol.for('@caffeinejs/std:app.config')

/**
 * Fluent definition of the application configuration sources, passed to
 * `.config(schema, c => c.source(...).context(...))`.
 *
 * The schema is supplied to `.config()` directly (not through this builder), so the application config type is
 * inferred from that argument regardless of the callback's shape — it may be a block body, a named function,
 * or omitted entirely. This builder writes straight into the live {@link ConfigDefinition}, so a source added
 * here sits in the same registry a feature builder contributes to later.
 *
 * Sources land in the `USER` band by default, above the framework and code-set defaults and below nothing else;
 * registration order breaks ties within a band. Pass an explicit {@link ConfigPriority} to place a source
 * elsewhere in the chain — that is also the supported way to make a source beat the environment.
 */
export class AppConfigBuilder<T = unknown> {
  /**
   * Phantom — names the application config type so `.config(schema, c => ...)` can flow it to the features
   * configured afterwards. Never assigned, never read.
   */
  declare readonly config?: T

  readonly #definition: ConfigDefinition

  constructor(definition: ConfigDefinition) {
    this.#definition = definition
  }

  /** Adds a single config source. Defaults to the `USER` band; ties broken by registration order. */
  source(provider: ConfigProvider, priority: ConfigPriorityValue = ConfigPriority.USER): this {
    this.#definition.sources.add(provider, priority)
    return this
  }

  /** Adds several config sources at once, in the given order (first wins within the band). */
  sources(...providers: ConfigProvider[]): this {
    this.#definition.sources.addAll(providers)
    return this
  }

  /**
   * Reads configuration from the command line, above every other source.
   *
   * The arguments themselves come from `app.run(argv)` — `run(process.argv)` on Node, `run(Deno.args)` on Deno.
   * They are opt-in rather than picked up automatically, because a process's flags are not always meant for it:
   * a test runner's own switches would otherwise silently become configuration.
   */
  args(options: ArgsConfigProviderOptions = {}): this {
    this.#definition.sources.add(new ArgsConfigProvider(options), ConfigPriority.ARGS)
    return this
  }

  /** Sets the resolution context (app name, profiles, label, ...). */
  context(context: ResolutionContext): this {
    // Preserve any argv already recorded — the context a caller writes describes the app, not the invocation.
    this.#definition.context = { argv: this.#definition.context.argv, ...context }
    return this
  }

  /** Stops a failing provider from aborting start-up; it contributes nothing instead. */
  failFast(failFast: boolean): this {
    this.#definition.failFast = failFast
    return this
  }
}
