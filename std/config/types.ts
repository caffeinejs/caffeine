import type { NamedToken } from '@caffeinejs/di'
import type { TSchema } from '@sinclair/typebox'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { Duration } from '../duration/duration.js'
import type { Logger } from '../logger/logger.js'
import type { AnySchema, InferSchema } from '../schema/schema.js'
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

/**
 * The config object an application injects. One identity for the life of the store, and every field follows
 * every reload.
 *
 * Reads separated by an `await` can come from two revisions. Code that needs one revision takes a
 * {@link ConfigSnapshot} first.
 */
export type LiveConfig<T> = ReadonlyConfig<T>

/** The validated tree at one revision. Frozen. A reload replaces it and never mutates it. */
export type ConfigSnapshot<T> = ReadonlyConfig<T>

/** What `newConfiguration(...).build()` returns and `loadConfig()` takes. Data only. */
export interface ConfigDefinition<T = unknown> {
  readonly schema: ConfigSchema<T>
  /**
   * The key the live config object is bound under. `T` is the application's own type, already read-only
   * (`InferConfig<typeof schema>`), so `token<AppConfig>()` is what an application writes.
   */
  readonly key: NamedToken<T> | undefined
  /** The key the typed store is bound under, for an application that wants one. */
  readonly storeKey: NamedToken<ConfigStore<T>> | undefined
  /** Lowest precedence first: a later source wins a conflicting value. */
  readonly sources: readonly ConfigSource[]
  /** Bounds each load of each source. */
  readonly loadTimeoutMs: number
}

/** Which trigger reloads a source. A `static` source is never reloaded. */
export type ConfigTrigger = 'static' | 'manual' | 'poll' | 'watch'

/** A value derived from the configuration that the store keeps current. */
export interface ConfigView<V> {
  /** Assigned by the store on swap. Reading it runs no selector. */
  readonly value: V
  /** Called when `value` changes. Returns the call that unsubscribes. */
  onChange(listener: ConfigChangeListener<V>): () => void
  /** Stops the updates and the listeners. The last value stays readable. */
  close(): void
}

/**
 * Notified when a value changes. May be async: a reload never waits for it, it never runs concurrently with
 * itself, and a burst of changes reaches it as the newest value only.
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
  readonly error: unknown
}

export interface ConfigExplanation {
  readonly path: string
  /** The value in the current snapshot, secrets redacted. */
  readonly value: unknown
  /** Every layer defining the path, winner first. Empty with a present value: a schema default. */
  readonly layers: readonly ConfigExplanationLayer[]
}

export interface ConfigExplanationLayer {
  readonly layer: string
  readonly origin: string
  /** Secrets redacted. */
  readonly value: unknown
}

export interface ConfigInspection {
  readonly revision: number
  /** When the current snapshot was swapped in, in milliseconds since the epoch. */
  readonly swappedAt: number
  readonly profiles: readonly string[]
  readonly sources: readonly ConfigSourceStatus[]
  /** The current snapshot, secrets redacted. */
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
