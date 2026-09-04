import { token, type NamedToken } from '@caffeinejs/di'

import { ConfigShard } from './integration/shard.js'
import { MutableConfigProvider } from './providers/mutable_provider.js'
import { type ConfigSchema, passthroughConfigSchema } from './schema.js'
import { secretPaths } from './secrets.js'
import { ConfigSlice, type ConfigSliceSpec } from './slice.js'
import { ConfigPriority, ConfigSources } from './sources.js'
import type { ResolutionContext } from './types.js'

/** DI key for the {@link ConfigDefinition} the application builder owns. Features resolve it to register a slice. */
export const kConfigDefinition = token<ConfigDefinition>(Symbol.for('@caffeinejs/std:config.definition'))

const DEFAULT_CONTEXT = (): ResolutionContext => ({ app: 'application', profiles: ['default'] })

/**
 * The live description of an application's configuration: its sources, its root schema, its resolution context,
 * and the feature slices carved out of the resulting tree.
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

  /** Framework defaults — the bottom of the chain. Everything overrides these. */
  readonly frameworkDefaults = new MutableConfigProvider('framework-defaults')
  /** Values set through feature builder methods. Defaults too: file, env and args all win over them. */
  readonly codeValues = new MutableConfigProvider('code')

  schema: ConfigSchema<unknown> = passthroughConfigSchema
  context: ResolutionContext = DEFAULT_CONTEXT()
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
  #shard: ConfigShard<unknown> | undefined

  constructor(token?: NamedToken<any>) {
    this.token = token
    this.sources.add(this.frameworkDefaults, ConfigPriority.FRAMEWORK)
    this.sources.add(this.codeValues, ConfigPriority.CODE)
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
      context: this.context,
      failFast: this.failFast,
      secrets: this.secrets,
      // Read through a closure, not by value: the application builder points `warn` at the host separately,
      // and may well do so after this definition was constructed.
      warn: message => this.warn?.(message),
    })

    return this.#shard
  }

  /**
   * Registers a feature slice and returns the holder its validated value is published into, on bootstrap and
   * on every refresh. `parts` is pre-split so no read path ever parses a dotted key.
   */
  slice<T>(parts: readonly string[], schema: ConfigSchema<T>): ConfigSlice<T> {
    for (const path of secretPaths(schema, parts)) {
      this.secrets.add(path)
    }

    // The warning channel is read lazily: features register their slices at `declare()`, and the
    // application builder points `warn` at the host separately. Passing it by value here would capture whatever
    // it happened to be — usually nothing.
    const slice = new ConfigSlice<T>(parts, () => this.warn)
    this.slices.push({ parts, schema, slice } as ConfigSliceSpec)
    return slice
  }
}
