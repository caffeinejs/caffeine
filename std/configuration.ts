import type { NamedToken } from '@caffeinejs/di'

import {
  ArgvConfigSource,
  DEFAULT_LOAD_TIMEOUT_MS,
  type ArgvConfigSourceOptions,
  type ConfigDefinition,
  type ConfigSchema,
  type ConfigSource,
  type ConfigStore,
  type DotenvOptions,
  type InferConfig,
} from './config/index.js'
import { type Duration, toMillis } from './duration/index.js'

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
  #dotenv: DotenvOptions | undefined

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
  argv(options: ArgvConfigSourceOptions = {}): this {
    return this.source(new ArgvConfigSource(options))
  }

  /** How long one load of one source may take. Defaults to 30 seconds. */
  loadTimeout(timeout: Duration): this {
    this.#loadTimeoutMs = toMillis(timeout)
    return this
  }

  /**
   * Loads dotenv files into `process.env` before any source loads: the base file, then the files of the active
   * profiles, the most specific winning. The environment the application was started with wins over every file.
   * An entry may read another, or the environment, with `${env:NAME}`, expanded as the files load.
   *
   * The base file may name the profiles with `CAFFEINE_PROFILES`. `--caffeine.profiles`, and a `CAFFEINE_PROFILES`
   * the environment already holds, win over it. Called again, it replaces the options.
   */
  dotEnv(options: DotenvOptions): this {
    this.#dotenv = options
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
      dotenv: this.#dotenv === undefined ? undefined : Object.freeze({ ...this.#dotenv }),
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
