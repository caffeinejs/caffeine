import type { TSchema } from '@sinclair/typebox'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { AnySchema, InferSchema } from '../schema/schema.js'

/**
 * The core vocabulary of `std/config`: the value shapes a provider produces, the schema types a feature
 * declares, the projections a caller reads through, and the records the diagnostics report.
 *
 * Type-only and dependency-free within the package, so every other module here may import it and none of them
 * can create a cycle by doing so. The behaviour lives with the code that implements it — `createLiveAccessors`
 * in `accessor.js`, `validateConfig` in `schema.js`, and so on.
 */

export type ConfigPrimitive = string | number | boolean | null
export type ConfigValue = ConfigPrimitive | ConfigValue[] | { [k: string]: ConfigValue }

export interface ConfigEntry {
  key: string
  value: ConfigValue
  origin: string
  profile?: string
  label?: string
}

export interface PropertySource {
  name: string
  entries: Map<string, ConfigEntry>
}

/**
 * What every provider is told about the resolution in progress: the active profiles, deduplicated and in the
 * order they were declared. Empty when the application named none.
 *
 * A profile-blind provider ignores it. {@link FileConfigProvider} reads it to pick up `name-<profile>`
 * siblings; {@link SpringCloudConfigProvider} reads it to build its request path. Everything else a single
 * provider needs from its host — an environment accessor, an argv array, a base URL, an application name — is a
 * constructor option of that provider, not a field here: a source that reads *somewhere* is handed that
 * somewhere by whoever constructed it.
 */
export interface ResolutionContext {
  profiles: readonly string[]
}

export interface ConfigSnapshot {
  sources: PropertySource[]
  values: Map<string, ConfigEntry>
}

export interface ConfigProvider {
  readonly id: string

  /**
   * Whether `load()` can ever return data differing from the last load. **Defaults to `false`.**
   *
   * Most sources cannot: the environment a process was started with, the arguments it was given and an inline
   * object are all fixed for its lifetime. A refresh with no reloadable source at all does nothing — it loads
   * nothing, re-validates nothing, and replaces no object — so declaring this is what buys a cheap refresh
   * rather than a pointless full resolve.
   *
   * Opt-in rather than opt-out on purpose: one source wrongly claiming it can change defeats the optimization
   * for the whole application, whereas one wrongly claiming it cannot is a visible bug in that source.
   */
  readonly reloadable?: boolean

  /**
   * A cheap stamp that changes whenever this source's data might have. When every reloadable source reports
   * the same stamp as last time, the refresh is skipped entirely.
   *
   * A source that cannot answer without doing the work — anything remote — should leave this undefined and be
   * reloaded every time.
   */
  revision?(): unknown

  load(ctx: ResolutionContext): Promise<PropertySource[]>
  dispose?(): void | Promise<void>
}

/**
 * A configuration schema: either the `$t` dialect (TypeBox, the first-class choice) or any
 * {@link https://standardschema.dev | Standard Schema} — zod v4, valibot, arktype and others.
 *
 * Configuration is the one place where a foreign library is supported without reservation: Caffeine calls the
 * library's own validator, so refinements and transforms run exactly as authored. This is unlike HTTP routes, where
 * validation is delegated to Fastify's Ajv and the schema must survive a projection to JSON Schema.
 *
 * The type parameter is phantom — it names the validated shape for call sites that declare a schema up front.
 */
export type ConfigSchema<T = unknown> = TSchema | StandardSchemaV1<unknown, T>

/** Infers the validated output type carried by a {@link ConfigSchema}. */
export type InferConfig<S extends AnySchema> = InferSchema<S>

/**
 * The read-only projection of a config type.
 *
 * Arrays are matched as `readonly (infer U)[]`, not `Array<infer U>`: the latter misses a field already
 * declared `readonly string[]`, and misses `string[] | undefined` entirely (a union matches neither branch and
 * falls through unchanged — mutable). Distributing over the union keeps an optional array an array, and object
 * elements are projected too, so `Server[]` does not hand back mutable `Server`s inside a read-only list.
 */
export type ConfigAccessors<T> = {
  readonly [K in keyof T]: ConfigValueOf<T[K]>
}

type ConfigValueOf<V> = V extends readonly (infer U)[]
  ? ReadonlyArray<ConfigValueOf<U>>
  : V extends (...args: never[]) => unknown
    ? V
    : V extends object
      ? ConfigAccessors<V>
      : V

/**
 * A location in a config tree a feature's settings may be pointed at.
 *
 * {@link ConfigAccessors} with every property optional, all the way down. That is what lets an application
 * declare only part of a feature's shape — `$t.Object({ port: $t.Number() })` where the feature wants
 * `{ port, host }` — and still name it with `newConfiguration(schema, key)`. The fields it left out arrive
 * from the feature's defaults, its builder, or the environment, and the feature reads one merged object
 * either way.
 *
 * Arrays stay read-only and the conditional stays in a helper for the same two reasons {@link ConfigAccessors}
 * gives: a declared `string[]` reads back off a handle as `readonly string[]`, and a union has to distribute.
 *
 * All-optional means the weak-type rule is what keeps an unrelated subtree out — a location sharing no
 * property name with `T` is rejected. One that shares a compatible name is not, and that surfaces when the
 * slice validates rather than at the selector.
 */
export type ConfigLocation<T> = {
  readonly [K in keyof T]?: ConfigLocationValue<T[K]>
}

type ConfigLocationValue<V> = V extends readonly (infer U)[]
  ? ReadonlyArray<ConfigLocationValue<U>>
  : V extends (...args: never[]) => unknown
    ? V
    : V extends object
      ? ConfigLocation<V>
      : V

/**
 * The root of a config tree: a read-only projection of the shape the application declared.
 *
 * Every node is live — a read goes through the tree as it stands now, so a value taken from a node rather
 * than copied out of it follows a refresh.
 */
export type ConfigHandle<T> = ConfigAccessors<T>

/** Notified when configuration changes. May be async; a refresh never waits for it. */
export type ConfigChangeListener<T> = (config: T, previous: T) => void | Promise<void>

/** One feature's configuration failing, carried with the namespace it belongs to. */
export interface ConfigSliceFailure {
  path: string
  error: unknown
}

export interface ConfigDiagnostics {
  originOf(path: string): string | undefined
  /** The value at `path`, with anything marked `$t.Secret` replaced by `[redacted]`. */
  valueAt(path: string): unknown
  /**
   * The resolved sources and merged values, secrets redacted.
   *
   * Redacted because this is the one thing here built to be dumped whole — to a log line, a debug endpoint, a
   * crash report — and a secret that survives that trip is a secret in a log.
   */
  readonly snapshot: ConfigSnapshot
  /**
   * The features whose configuration failed to resolve on the most recent pass. Empty when everything
   * resolved. After a refresh these are the only features still serving values from an earlier one.
   */
  readonly sliceErrors: readonly ConfigSliceFailure[]
}
