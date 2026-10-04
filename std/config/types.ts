import type { NamedToken, Provider } from '@caffeinejs/di'
import type { TSchema } from '@sinclair/typebox'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { Duration } from '../duration/duration.js'
import type { Logger } from '../logger/logger.js'
import type { AnySchema, InferSchema } from '../schema/schema.js'
import type { DotenvOptions } from './dotenv.js'
import type { ErrConfigValidation } from './errors.js'
import type { ConfigStore } from './store.js'

export type ConfigPrimitive = string | number | boolean | null
export type ConfigValue = ConfigPrimitive | readonly ConfigValue[] | ConfigObject

export interface ConfigObject {
  readonly [key: string]: ConfigValue
}

/** What one source contributed: a named, sparse tree. */
export interface ConfigLayer {
  /** Shown in logs and by `explain()`, e.g. `file:./config/app-eu.json`. */
  readonly name: string
  readonly data: ConfigObject
  /** Provenance finer than the layer, by dotted path: `server.port` to `env:APP_SERVER__PORT`. */
  readonly origins?: ReadonlyMap<string, string>
  readonly profile?: string
  /**
   * Whether the placeholders in this layer's strings are filled in once every layer has merged, before validation:
   * `${env:NAME}` with an environment variable, `${config:path}` with a value of the merged configuration, and
   * `${env:NAME:-text}` with `text` when there is nothing better. A placeholder that loses the merge is never filled
   * in, and what one brings in is taken as it is.
   *
   * A placeholder can read any environment variable: set this only on text the application's own authors wrote.
   */
  readonly interpolate?: boolean
}

/** What a source is told while it loads. */
export interface ConfigLoadContext {
  /** The active profiles, deduplicated, in the order they were named. Empty when none was. */
  readonly profiles: readonly string[]
  /** Aborted when the load times out and when the store closes. */
  readonly signal: AbortSignal
  /** Bound to `{ name: 'config', source }`. */
  readonly logger: Logger
}

/**
 * Where configuration comes from.
 *
 * A source with none of `live`, `pollInterval` and `watch` is static: it is loaded once, at start-up, and never
 * again, not even by `reload()`.
 */
export interface ConfigSource {
  /** Unique within one configuration. */
  readonly name: string
  /**
   * This source's layers, lowest precedence first. Runs at start-up, and again on each reload of a live source, but
   * never while an earlier call still runs, even one the store stopped waiting for.
   */
  load(context: ConfigLoadContext): readonly ConfigLayer[] | Promise<readonly ConfigLayer[]>
  /** The data can change while the process runs. */
  readonly live?: boolean
  /** The store reloads this source on this period. Implies `live`. */
  readonly pollInterval?: Duration
  /** Calls `changed` whenever `load` would now return something else. Returns the stop call. Implies `live`. */
  watch?(changed: () => void): () => void
  /**
   * Start-up proceeds without this source when its first load fails. Its trigger still retries it.
   *
   * Absence is not failure: a source with nothing to contribute returns no layer, and needs no flag for it.
   */
  readonly optional?: boolean
  close?(): void | Promise<void>
}

/**
 * A configuration schema: the `$t` dialect (TypeBox) or any {@link https://standardschema.dev | Standard Schema},
 * such as zod v4, valibot or arktype. The library's own validator runs, refinements and transforms included.
 */
export type ConfigSchema<T = unknown> = TSchema | StandardSchemaV1<unknown, T>

/**
 * The deep read-only projection of `T`: arrays become read-only, elements included, and functions pass through.
 * Projecting a projection changes nothing.
 */
export type ReadonlyConfig<T> = {
  readonly [K in keyof T]: ReadonlyConfigValue<T[K]>
}

type ReadonlyConfigValue<V> = V extends readonly (infer U)[]
  ? ReadonlyArray<ReadonlyConfigValue<U>>
  : V extends (...args: never[]) => unknown
    ? V
    : V extends object
      ? ReadonlyConfig<V>
      : V

/** The type an application gives its configuration: `type AppConfig = InferConfig<typeof schema>`. */
export type InferConfig<S extends AnySchema> = ReadonlyConfig<InferSchema<S>>

type KeyOfAny<T> = T extends unknown ? keyof T : never

/**
 * Compiles only when `Config` can be handed to a `config(...)` taking `Partial<Options>` and declares no top-level
 * key `Options` lacks. A feature's configuration schema asserts it against itself:
 *
 * @example
 * ```ts
 * type _Satisfies = SchemaSatisfies<KafkaConfig, InferConfig<typeof KafkaConfigSchema>>
 * ```
 */
export type SchemaSatisfies<
  Options,
  Config extends Partial<Options> & { readonly [K in Exclude<keyof Config, KeyOfAny<Options>>]: never },
> = Config

/** The validated tree at one revision. Frozen. A reload replaces it and never mutates it. */
export type ConfigSnapshot<T> = ReadonlyConfig<T>

/** What `newConfiguration(...).build().config` holds and `loadConfig()` takes. Data only. */
export interface ConfigDefinition<T = unknown> {
  readonly schema: ConfigSchema<T>
  /** Resolves to the snapshot the application started with. A reload never reaches it. */
  readonly configToken: NamedToken<T>
  /** Resolves to a provider whose `get()` answers the snapshot of the current revision. */
  readonly liveConfigToken: NamedToken<Provider<T>>
  /** Resolves to the store, typed after the schema. */
  readonly storeToken: NamedToken<ConfigStore<T>>
  /** Lowest precedence first: a later source wins a conflicting value. */
  readonly sources: readonly ConfigSource[]
  /** Bounds each load of each source. */
  readonly loadTimeoutMs: number
  /** Dotenv files loaded into `process.env` before any source. */
  readonly dotenv?: DotenvOptions
}

/** Which trigger reloads a source. A `static` source is never reloaded. */
export type ConfigTrigger = 'static' | 'manual' | 'poll' | 'watch'

/**
 * Notified, synchronously, right after a reload swapped in a new snapshot. A reload does not wait for a promise it
 * returns, and it never runs concurrently with itself: a swap that lands before that promise settles reaches it once
 * it has, the newest only.
 */
export type ConfigChangeListener<V> = (value: V, previous: V, change: ConfigChange) => void | Promise<void>

export interface ConfigChange {
  readonly revision: number
  /** Dotted paths whose value differs. An array is reported once, at its own path. */
  readonly changed: readonly string[]
}

export interface ConfigReloadOutcome {
  readonly status: 'applied' | 'unchanged' | 'rejected'
  readonly revision: number
  readonly changed: readonly string[]
  /** Present when `status` is `rejected`. */
  readonly error?: ErrConfigValidation
  /** Sources whose load failed. Each kept its last good layers. */
  readonly failures: readonly ConfigSourceFailure[]
}

export interface ConfigSourceFailure {
  readonly source: string
  /** Whether the source was declared `optional`, so that the configuration does not depend on it. */
  readonly optional: boolean
  readonly error: unknown
}

export interface ConfigExplanation {
  readonly path: string
  /** The value in the current snapshot, as it is. */
  readonly value: unknown
  /** Every layer defining the path, winner first. Empty with a present value: a schema default. */
  readonly layers: readonly ConfigExplanationLayer[]
}

export interface ConfigExplanationLayer {
  readonly layer: string
  readonly origin: string
  /** The value this layer supplies, as it is. */
  readonly value: unknown
}

export interface ConfigInspection {
  readonly revision: number
  readonly profiles: readonly string[]
  readonly sources: readonly ConfigSourceStatus[]
  /** The current snapshot, every value as it is. */
  readonly snapshot: unknown
}

export interface ConfigSourceStatus {
  readonly name: string
  readonly trigger: ConfigTrigger
  readonly layers: readonly string[]
  readonly keys: number
  /** In milliseconds since the epoch. `0` when no load has succeeded yet. */
  readonly lastLoadedAt: number
  readonly lastLoadMs: number
  readonly consecutiveFailures: number
  readonly lastError?: unknown
}
