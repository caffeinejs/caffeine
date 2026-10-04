import { token, type NamedToken, type Provider } from '@caffeinejs/di'

import {
  DEFAULT_LOAD_TIMEOUT_MS,
  type ConfigDefinition,
  type ConfigSchema,
  type ConfigSource,
  type ConfigStore,
  type DotenvOptions,
  type InferConfig,
} from './config/index.js'
import { ArgvConfigSource, type ArgvConfigSourceOptions } from './config/sources/argv/index.js'
import { type Duration, toMillis } from './duration/index.js'

/** What {@link ConfigurationBuilder.build} returns: the definition the application loads, and its tokens. */
export interface Configuration<T> {
  /** Handed to the application: `createApplication({ config: conf.config })`. */
  readonly config: ConfigDefinition<T>
  /**
   * Resolves to the configuration the application started with. A reload never reaches it, so a singleton and a
   * transient built after a reload read the same values.
   */
  readonly configToken: NamedToken<T>
  /**
   * Resolves to a provider whose `get()` answers the configuration as it is now. What a component built once
   * injects to follow reloads.
   */
  readonly liveConfigToken: NamedToken<Provider<T>>
  /** Resolves to the store the configuration was loaded into, typed after the schema. */
  readonly storeToken: NamedToken<ConfigStore<T>>
}

/**
 * Fluent definition of an application's configuration, started with {@link newConfiguration}.
 *
 * Precedence is registration order alone: a source added later wins a conflicting value, so the override is added
 * last.
 */
export class ConfigurationBuilder<T = unknown> {
  readonly #schema: ConfigSchema<T>
  readonly #sources: ConfigSource[] = []
  #loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS
  #dotenv: DotenvOptions | undefined

  constructor(schema: ConfigSchema<T>) {
    this.#schema = schema
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

  /** Finishes the configuration. What it returns is data, fixed from here on, and its tokens are new each call. */
  build(): Configuration<T> {
    // `token<T>()` refuses a `T` it cannot see is named; the schema names it, so the symbol is branded directly.
    const configToken = Symbol('caffeine.config') as NamedToken<T>
    const liveConfigToken = token<Provider<T>>(Symbol('caffeine.config.live'))
    const storeToken = token<ConfigStore<T>>(Symbol('caffeine.config.store'))

    return Object.freeze({
      config: Object.freeze({
        schema: this.#schema,
        configToken,
        liveConfigToken,
        storeToken,
        sources: Object.freeze([...this.#sources]),
        loadTimeoutMs: this.#loadTimeoutMs,
        dotenv: this.#dotenv === undefined ? undefined : Object.freeze({ ...this.#dotenv }),
      }),
      configToken,
      liveConfigToken,
      storeToken,
    })
  }
}

/**
 * Starts a configuration, validated against `schema`. What `build()` returns carries the tokens, typed after the
 * schema:
 *
 * ```ts
 * const conf = newConfiguration(appConfigSchema).source(new EnvConfigSource({ prefix: 'APP_' })).build()
 *
 * export const kConfig = conf.configToken          // the configuration the application started with
 * export const kLiveConfig = conf.liveConfigToken  // a Provider: `get()` answers the configuration now
 * export const kConfigStore = conf.storeToken      // the store: `explain()`, `reload()`, `onChange()`
 *
 * createApplication({ config: conf.config })
 * ```
 */
export function newConfiguration<S extends ConfigSchema>(schema: S): ConfigurationBuilder<InferConfig<S>> {
  return new ConfigurationBuilder<InferConfig<S>>(schema as ConfigSchema<InferConfig<S>>)
}
