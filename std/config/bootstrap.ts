import type { AnySchema } from '../schema/schema.js'
import type { ConfigHandle } from './accessor.js'
import { createLiveAccessors } from './accessor.js'
import type { ConfigDiagnostics } from './diagnostics.js'
import { createConfigDiagnostics } from './diagnostics.js'
import { ConfigEngine } from './engine.js'
import type { ConfigSliceFailure } from './errors.js'
import { materialize, readByParts } from './materializer.js'
import { activeProfiles } from './profiles.js'
import type { ConfigSchema, InferConfig } from './schema.js'
import { validateConfig } from './schema.js'
import { secretPaths } from './secrets.js'
import type { ConfigSlice, ConfigSliceSpec } from './slice.js'
import { featureLookup, freezeDeep, sliceLabel } from './slice.js'
import { ConfigSources } from './sources.js'
import type { ConfigProvider, ConfigSnapshot } from './types.js'

export interface BootstrapOptions<T> {
  /** The live source registry. Preferred — it is re-read on every resolve, so late registrations take effect. */
  sources?: ConfigSources
  /** Convenience for a fixed set of sources; equivalent to a registry holding them in the `USER` band. */
  providers?: ConfigProvider[]
  schema: ConfigSchema<T>
  /** Feature slices to validate and publish alongside the root config. */
  slices?: readonly ConfigSliceSpec[]
  /**
   * The active profiles, stated outright. Skips discovery — for a direct or standalone caller that already
   * knows them. {@link activeProfiles} still normalizes the value, so a duplicate or a blank is harmless.
   */
  profiles?: readonly string[]
  /**
   * The tree path holding the active-profile list, for the two-phase path: when this is set and `profiles` is
   * not, resolution runs once with no profile to read this key, then again profile-aware.
   *
   * The cost is one extra full resolve per bootstrap and per refresh for an application that names a profile;
   * one that names none pays nothing, the probe result is reused. Discovery is single-pass — a profile file
   * that itself sets this key does not trigger another round.
   */
  profilesPath?: readonly string[]
  failFast?: boolean
  /**
   * Paths the diagnostics must redact, on top of whatever the root schema marks with `$t.Secret`. The config
   * module passes the set the feature slices contributed as they registered.
   */
  secrets?: ReadonlySet<string>
  /** The slices published under a feature key, which the resulting handle answers a key with. */
  features?: ReadonlyMap<symbol, ConfigSlice<unknown>>
  /**
   * Reports a refresh that failed for one feature while the rest succeeded. Such a failure is deliberately not
   * thrown — the application keeps running on the last good values — so without this it would be silent unless
   * somebody thought to read the diagnostics.
   */
  warn?: (message: string) => void
}

export interface ConfigBootstrapResult<T> {
  config: ConfigHandle<T>
  diagnostics: ConfigDiagnostics
  validated: T
  snapshot: ConfigSnapshot
  /** The merged tree before root validation — what feature slices are read from. */
  materialized: Record<string, unknown>
  /** The features whose configuration could not be resolved this pass. */
  failures: readonly ConfigSliceFailure[]
  /** Every path to redact: the root schema's `$t.Secret` marks plus whatever the slices contributed. */
  secrets: ReadonlySet<string>
}

/** Normalizes the two accepted spellings of "which sources" into the live registry the engine wants. */
export function sourcesOf<T>(options: BootstrapOptions<T>): ConfigSources {
  return options.sources ?? ConfigSources.of(...(options.providers ?? []))
}

/**
 * Resolves every provider, materializes the result, and validates it against the schema.
 *
 * The first overload infers the config type from the schema, which is what a direct caller wants — a `$t` schema
 * satisfies `ConfigSchema<T>` for any `T`, so `T` cannot be recovered from the parameter alone. The second serves
 * the internal path, where the config type is already known and threaded down from the application builder.
 */
export async function bootstrapConfig<S extends AnySchema>(
  options: { schema: S } & Omit<BootstrapOptions<never>, 'schema'>,
): Promise<ConfigBootstrapResult<InferConfig<S>>>
export async function bootstrapConfig<T>(options: BootstrapOptions<T>): Promise<ConfigBootstrapResult<T>>
export async function bootstrapConfig<T>(options: BootstrapOptions<T>): Promise<ConfigBootstrapResult<T>> {
  const engine = new ConfigEngine({ sources: sourcesOf(options), failFast: options.failFast })

  let snapshot: ConfigSnapshot
  if (options.profiles === undefined && options.profilesPath !== undefined) {
    // Phase 1 — no active profile yet: resolve to discover which profiles the tree declares.
    const probe = await engine.resolve({ profiles: [] })
    const profiles = activeProfiles(readByParts(materialize(probe), options.profilesPath))
    snapshot = profiles.length === 0 ? probe : await engine.resolve({ profiles })
  } else {
    snapshot = await engine.resolve({ profiles: activeProfiles(options.profiles ?? []) })
  }
  const materialized = materialize(snapshot)

  const failures = publishSlices(options.slices, materialized)

  // What the live handle reads through to, so freezing makes the read-only typing true at runtime and lets the
  // handle hand back arrays directly instead of copying them on every read.
  //
  // Exactly what the application declared, and nothing else: a feature contributes no field here. Its settings
  // are in the root tree when the application put them there — declared in the schema and named by the
  // feature's `.config(...)` selector — and nowhere at all otherwise.
  const validated = freezeDeep(validateConfig(options.schema, materialized))
  const config = createLiveAccessors(
    () => validated,
    undefined,
    featureLookup(options.features, slice => slice.config),
  )
  // The root schema is walked here rather than by the caller: an application that declared its own secrets in
  // `.config(schema, ...)` gets them redacted whether or not any feature registered a slice.
  const secrets = new Set([...(options.secrets ?? []), ...secretPaths(options.schema)])
  const diagnostics = createConfigDiagnostics(validated, snapshot, failures, secrets)

  return { config, diagnostics, validated, snapshot, materialized, failures, secrets }
}

/**
 * Validates each feature slice and hands it to its holder.
 *
 * Slices read from the **materialized** tree rather than the root-validated one on purpose: both zod's
 * `.object()` and TypeBox's `Value.Clean` drop keys the schema does not declare, so a feature namespace the
 * application never described would be stripped before the feature ever saw it. The root schema governs the
 * application's own config key; a slice governs itself.
 *
 * A location that resolves to nothing validates as an empty object, which lets the feature's own schema
 * defaults — and the framework-band values written beneath it — decide the outcome instead of failing.
 *
 * A **detached** slice validates its own values instead: the application never named a location for it, so
 * there is nothing in the tree that could be meant for it, and reading one would be guessing.
 *
 * **Failures are isolated.** Each slice validates and derives inside its own guard, so a feature with an
 * unusable value does not stop every other feature from resolving. The failures are returned rather than
 * thrown; what to do about them is a decision for the caller, and it differs between start-up (a process that
 * cannot serve a feature should not start) and a refresh (a running process must not lose working features
 * because a reload went bad).
 */
export function publishSlices(
  slices: readonly ConfigSliceSpec[] | undefined,
  materialized: Record<string, unknown>,
): readonly ConfigSliceFailure[] {
  const failures: ConfigSliceFailure[] = []

  for (const spec of slices ?? []) {
    try {
      const raw = spec.parts === undefined ? (spec.local ?? {}) : (readByParts(materialized, spec.parts) ?? {})
      // Publishing also runs this slice's derivations, so a derivation that rejects the combination as a whole
      // is caught by the same guard as a field that failed to validate.
      spec.slice.publish(freezeDeep(validateConfig(spec.schema, raw)))
    } catch (error) {
      spec.slice.fail(error)
      failures.push({ path: sliceLabel(spec.parts), error })
    }
  }

  return failures
}

/**
 * Delivers every slice's change notification, once all of them have published.
 *
 * The two phases are what make a listener's view of the world consistent. Notifying as each slice publishes
 * would have the first feature reached looking at slices that have not been updated yet, and reacting to a
 * configuration that never existed as a whole.
 */
export function notifySlices(slices: readonly ConfigSliceSpec[] | undefined): void {
  for (const spec of slices ?? []) {
    spec.slice.notify()
  }
}
