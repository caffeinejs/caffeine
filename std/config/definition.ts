import { token, type NamedToken } from '@caffeinejs/di'

import { ErrConfig } from './errors.js'
import type { FeatureConfigKey } from './feature_key.js'
import { ConfigShard } from './integration/shard.js'
import { MutableConfigProvider } from './providers/mutable_provider.js'
import { declaredDefaults, type ConfigSchema, passthroughConfigSchema } from './schema.js'
import { secretPaths } from './secrets.js'
import { ConfigSlice, type ConfigSliceSpec } from './slice.js'
import { ConfigPriority, ConfigSources } from './sources.js'
import type { ConfigValue } from './types.js'

/** DI key for the {@link ConfigDefinition} the application builder owns. Features resolve it to register a slice. */
export const kConfigDefinition = token<ConfigDefinition>(Symbol.for('@caffeinejs/std:config.definition'))

/**
 * The live description of an application's configuration: its sources, its root schema, where its active
 * profiles are read from, and the feature slices carved out of the resulting tree.
 *
 * Live is the whole point. The previous design snapshotted the provider list when `.config()` was called, which
 * meant nothing registered afterwards could ever be seen — and feature builders necessarily run afterwards, at
 * `declare()`. Holding one mutable definition that {@link bootstrap} reads once every feature has declared lets
 * the application builder and every feature contribute to the same tree, in whatever order they happen to run.
 */
export class ConfigDefinition {
  /**
   * The key the resolved configuration handle is bound under, supplied by the application to `.config()`. Absent
   * until then, and absent for good in an application that never declares a configuration of its own — a slice
   * still resolves, and value injection still reads the tree, without anything bound at the root.
   */
  token: NamedToken<any> | undefined
  readonly sources = new ConfigSources()
  readonly slices: ConfigSliceSpec[] = []
  /**
   * The slices published under a {@link FeatureConfigKey}, which is how a reader that holds no builder finds
   * one. Keyed by identity rather than by namespace, so a feature that relocated its settings is still found.
   */
  readonly features = new Map<symbol, ConfigSlice<unknown>>()

  /** Framework defaults — the bottom of the chain. Everything overrides these. */
  readonly frameworkDefaults = new MutableConfigProvider('framework-defaults')
  /**
   * Defaults read off the application's own schema, so that declaring `server.port` with a `default` actually
   * reaches the server rather than only filling the root tree.
   *
   * A schema default cannot do this on its own: a feature writes its framework defaults as real values, and a
   * schema default only fills a value that is *absent*. Lifting them into a band is what puts the two in the
   * same merge.
   */
  readonly schemaDefaults = new MutableConfigProvider('schema-defaults')
  /** Values set through feature builder methods. Defaults too: file, env and args all win over them. */
  readonly codeValues = new MutableConfigProvider('code')

  /**
   * The tree path holding the application's active-profile list, e.g. `['caffeine', 'profiles']`. The host
   * points it here before {@link bootstrap}; `std/config` never assumes a location. Unset, resolution runs
   * with no active profile — no profile-segregated file or overlay is loaded.
   */
  profilesPath: readonly string[] | undefined
  failFast: boolean | undefined
  /**
   * Paths marked with `$t.Secret`, collected as each slice registers and from the root schema at bootstrap.
   * Read by the diagnostics, which redact them; nothing on a feature's own read path consults this.
   */
  readonly secrets = new Set<string>()
  /**
   * Reports a refresh that failed for one feature. The application builder points this at the host's warning
   * channel; `std/config` never reaches for one itself, so it stays free of any host dependency.
   */
  warn: ((message: string) => void) | undefined
  #schema: ConfigSchema<unknown> = passthroughConfigSchema
  #shard: ConfigShard<unknown> | undefined

  constructor(token?: NamedToken<any>) {
    this.token = token
    this.sources.add(this.frameworkDefaults, ConfigPriority.FRAMEWORK)
    this.sources.add(this.schemaDefaults, ConfigPriority.SCHEMA)
    this.sources.add(this.codeValues, ConfigPriority.CODE)
  }

  /** The schema the root tree is validated against. Defaults to {@link passthroughConfigSchema}. */
  get schema(): ConfigSchema<unknown> {
    return this.#schema
  }

  /**
   * Declaring the schema also publishes the defaults it carries into the `SCHEMA` band, which is what lets an
   * application default a feature it did not write. Done on assignment rather than in a separate call so the
   * two cannot drift apart.
   */
  set schema(schema: ConfigSchema<unknown>) {
    this.#schema = schema
    this.schemaDefaults.replace(declaredDefaults(schema) as Record<string, ConfigValue>)
  }

  /** Whether the configuration has been resolved. After this, changes need a refresh to take effect. */
  get bootstrapped(): boolean {
    return this.#shard !== undefined
  }

  /** The resolved configuration, once {@link bootstrap} has run. The config module binds what this holds. */
  get shard(): ConfigShard<unknown> | undefined {
    return this.#shard
  }

  /**
   * Resolves every source, validates the tree, and publishes each feature slice. Idempotent — the second call
   * hands back the same shard rather than resolving again.
   *
   * The application runs this between the two service steps: after every `declare` has contributed its
   * defaults and slices, and before any `configure` reads one. A slice that cannot be resolved fails start-up
   * here, which is earlier and more legible than failing at whatever moment the feature was first used.
   */
  async bootstrap(): Promise<ConfigShard<unknown>> {
    this.#shard ??= await ConfigShard.bootstrap<unknown>({
      sources: this.sources,
      // Type-erased: the schema is whatever `.config()` declared, and the config type is recovered by the
      // caller that named it.
      schema: this.schema,
      slices: this.slices,
      profilesPath: this.profilesPath,
      failFast: this.failFast,
      secrets: this.secrets,
      features: this.features,
      // Read through a closure, not by value: the application builder points `warn` at the host separately,
      // and may well do so after this definition was constructed.
      warn: message => this.warn?.(message),
    })

    return this.#shard
  }

  /**
   * Registers a feature slice and returns the holder its validated value is published into, on bootstrap and
   * on every refresh. `parts` is pre-split so no read path ever parses a dotted key.
   *
   * `parts` `undefined` registers a **detached** slice: it is validated from `local` rather than from the tree,
   * for a feature the application never pointed at a location.
   */
  slice<T>(
    parts: readonly string[] | undefined,
    schema: ConfigSchema<T>,
    local?: Record<string, unknown>,
  ): ConfigSlice<T> {
    // Only a slice in the tree has paths to redact; a detached one is never in the resolved snapshot the
    // diagnostics walk.
    for (const path of parts === undefined ? [] : secretPaths(schema, parts)) {
      this.secrets.add(path)
    }

    // The warning channel is read lazily: features register their slices at `declare()`, and the
    // application builder points `warn` at the host separately. Passing it by value here would capture whatever
    // it happened to be — usually nothing.
    const slice = new ConfigSlice<T>(parts, () => this.warn)
    this.slices.push({ parts, schema, slice, local } as ConfigSliceSpec)
    return slice
  }

  /**
   * Publishes a slice under a feature key, making it readable through the configuration handle.
   *
   * A key names one slice. Two registrations under the same key would leave which one a reader gets decided by
   * the order the features happened to install in, so the second is refused instead — which is also what tells
   * a multi-instance feature that one key cannot address all of its instances.
   */
  publishFeature<T>(key: FeatureConfigKey<T>, slice: ConfigSlice<T>): void {
    if (this.features.has(key)) {
      throw new ErrConfig(
        `Cannot register feature config "${key.description ?? key.toString()}": a slice is already registered for that key`,
        'ERR_CONFIG_FEATURE_CONFLICT',
        undefined,
        'Register the slice once, from the feature builder that owns it',
        'Give each instance of a multi-instance feature its own key',
      )
    }

    this.features.set(key, slice as ConfigSlice<unknown>)
  }
}
