import type { NamedToken } from '@caffeinejs/di'

import {
  ArgsConfigProvider,
  ConfigDefinition,
  ConfigPriority,
  type ArgsConfigProviderOptions,
  type ConfigHandle,
  type ConfigPriorityValue,
  type ConfigProvider,
  type ConfigSchema,
  type InferConfig,
} from './config/index.js'

/**
 * The phantom a configuration carries to name its type. Never assigned, never read at runtime —
 * `declare readonly __config?: T` is the whole implementation.
 */
export interface ApplicationConfigMarker<T> {
  readonly __config?: T
}

/**
 * A finished configuration, ready to hand to `createApplication`/`createWebApplication` as `{ config }`.
 *
 * Named apart from `@caffeinejs/std/config`'s `Configuration` class — that one is the *resolved* runtime
 * accessor (`container.get(Configuration)`); this is the *declared*, not-yet-resolved definition a builder
 * hands to an application's constructor.
 *
 * It is a real {@link ConfigDefinition} — `newConfiguration(...).build()` does not wrap it — so a source added
 * to it after `.build()` (before the application reads it at `ready()`) still lands in the tree. `T` is a
 * phantom: it never appears at runtime, only in the type this flows to the application's own `TConfig`.
 */
export type AppConfiguration<T = unknown> = ConfigDefinition & ApplicationConfigMarker<T>

/**
 * Fluent definition of an application's configuration sources, started with {@link newConfiguration}.
 *
 * Sources land in the `USER` band by default, above the framework and code-set defaults and below nothing
 * else; registration order breaks ties within a band. Pass an explicit {@link ConfigPriority} to place a
 * source elsewhere in the chain — that is also the supported way to make a source beat the environment.
 */
export class ConfigurationBuilder<T = unknown> {
  readonly #definition: ConfigDefinition

  constructor(schema: ConfigSchema<unknown>, key: NamedToken<ConfigHandle<T>>) {
    this.#definition = new ConfigDefinition(key)
    this.#definition.schema = schema
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
   * The arguments are the host's own unless `options.argv` names others. Calling this is the opt-in: an
   * application that never does reads no command line at all.
   */
  args(options: ArgsConfigProviderOptions = {}): this {
    this.#definition.sources.add(new ArgsConfigProvider(options), ConfigPriority.ARGS)
    return this
  }

  /** Stops a failing provider from aborting start-up; it contributes nothing instead. */
  failFast(failFast: boolean): this {
    this.#definition.failFast = failFast
    return this
  }

  /** Finishes the configuration. Runtime returns the live {@link ConfigDefinition}; only the type is new. */
  build(): AppConfiguration<T> {
    return this.#definition as AppConfiguration<T>
  }
}

/**
 * Starts a configuration: the schema it is validated against, and the key its resolved {@link ConfigHandle} is
 * bound under.
 *
 * The key is the application's, so the binding is typed: `container.get(key)` needs no type argument. The
 * schema comes first, which is what lets the compiler ask for the exact token type it implies.
 *
 * ```ts
 * const kConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))
 *
 * const conf = newConfiguration(schema, kConfig).source(new EnvConfigProvider()).build()
 *
 * createApplication({ config: conf })
 * ```
 */
export function newConfiguration<S extends ConfigSchema, T extends InferConfig<NoInfer<S>> = InferConfig<NoInfer<S>>>(
  schema: S,
  key: NamedToken<ConfigHandle<T>>,
): ConfigurationBuilder<T> {
  return new ConfigurationBuilder<T>(schema as ConfigSchema<unknown>, key)
}
