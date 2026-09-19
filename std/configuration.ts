import type { NamedToken } from '@caffeinejs/di'

import {
  ArgsConfigSource,
  DEFAULT_LOAD_TIMEOUT_MS,
  type ArgsConfigSourceOptions,
  type ConfigDefinition,
  type ConfigSchema,
  type ConfigSource,
  type ConfigStore,
  type InferConfig,
} from './config/index.js'
import type { Duration } from './duration/index.js'
import { toMillis } from './shutdown/shutdown_options.js'

/**
 * Fluent definition of an application's configuration, started with {@link newConfiguration}.
 *
 * Precedence is registration order alone: a source added later wins a conflicting value, so the override is added
 * last.
 */
export class ConfigurationBuilder<T = unknown> {
  readonly #schema: ConfigSchema<T>
  readonly #key: NamedToken<T>
  readonly #storeKey: NamedToken<ConfigStore<T>> | undefined
  readonly #sources: ConfigSource[] = []
  #loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS

  constructor(schema: ConfigSchema<T>, key: NamedToken<T>, storeKey?: NamedToken<ConfigStore<T>>) {
    this.#schema = schema
    this.#key = key
    this.#storeKey = storeKey
  }

  /** Adds a source. It wins a conflicting value over every source added before it. */
  source(source: ConfigSource): this {
    this.#sources.push(source)
    return this
  }

  /** Adds several sources, in order: a later one in the list wins over an earlier one. */
  sources(...sources: ConfigSource[]): this {
    this.#sources.push(...sources)
    return this
  }

  /**
   * Reads configuration from the command line: the host's own arguments unless `options.argv` names others. Calling
   * this is the opt-in, and like any source it wins only over the sources added before it.
   */
  args(options: ArgsConfigSourceOptions = {}): this {
    return this.source(new ArgsConfigSource(options))
  }

  /** How long one load of one source may take. Defaults to 30 seconds. */
  loadTimeout(timeout: Duration): this {
    this.#loadTimeoutMs = toMillis(timeout)
    return this
  }

  /** Finishes the configuration. What it returns is data, fixed from here on. */
  build(): ConfigDefinition<T> {
    return Object.freeze({
      schema: this.#schema,
      key: this.#key,
      storeKey: this.#storeKey,
      sources: Object.freeze([...this.#sources]),
      loadTimeoutMs: this.#loadTimeoutMs,
    })
  }
}

/**
 * Starts a configuration: the schema it is validated against, the key the live config object is bound under, and
 * optionally a key for the typed store.
 *
 * The key names the application's own type, so the schema and the key must agree:
 *
 * ```ts
 * export type AppConfig = InferConfig<typeof appConfigSchema>
 * export const kConfig = token<AppConfig>(Symbol('app.config'))
 *
 * const conf = newConfiguration(appConfigSchema, kConfig).source(new EnvConfigSource({ prefix: 'APP_' })).build()
 *
 * createApplication({ config: conf })
 * ```
 */
export function newConfiguration<S extends ConfigSchema, T extends InferConfig<NoInfer<S>> = InferConfig<NoInfer<S>>>(
  schema: S,
  key: NamedToken<T>,
  storeKey?: NamedToken<ConfigStore<T>>,
): ConfigurationBuilder<T> {
  return new ConfigurationBuilder<T>(schema as ConfigSchema<T>, key, storeKey)
}
