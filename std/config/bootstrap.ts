import type { AnySchema } from '../schema/schema.js'
import type { ConfigHandle } from './accessor.js'
import { createLiveAccessors } from './accessor.js'
import type { ConfigDiagnostics } from './diagnostics.js'
import { createConfigDiagnostics } from './diagnostics.js'
import { ConfigEngine } from './engine.js'
import type { ConfigSliceFailure } from './errors.js'
import { materialize, readByParts, setByPath } from './materializer.js'
import type { ConfigSchema, InferConfig } from './schema.js'
import { validateConfig } from './schema.js'
import { secretPaths } from './secrets.js'
import type { ConfigSlice, ConfigSliceSpec } from './slice.js'
import { featureLookup, freezeDeep } from './slice.js'
import { ConfigSources } from './sources.js'
import type { ConfigProvider, ConfigSnapshot, ResolutionContext } from './types.js'

export interface BootstrapOptions<T> {
  /** The live source registry. Preferred — it is re-read on every resolve, so late registrations take effect. */
  sources?: ConfigSources
  /** Convenience for a fixed set of sources; equivalent to a registry holding them in the `USER` band. */
  providers?: ConfigProvider[]
  schema: ConfigSchema<T>
  /** Feature slices to validate and publish alongside the root config. */
  slices?: readonly ConfigSliceSpec[]
  context?: ResolutionContext
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

const DEFAULT_CONTEXT: ResolutionContext = { app: 'application', profiles: ['default'] }

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
  const ctx = options.context ?? { ...DEFAULT_CONTEXT, profiles: [...DEFAULT_CONTEXT.profiles] }
  const engine = new ConfigEngine({ sources: sourcesOf(options), failFast: options.failFast })

  const snapshot = await engine.resolve(ctx)
  const materialized = materialize(snapshot)

  // Before the root tree is built, because what the slices publish is what gets overlaid onto it.
  const failures = publishSlices(options.slices, materialized)

  // Frozen once, after the overlay: it is what the live handle reads through to, so freezing makes the
  // read-only typing true at runtime and lets the handle hand back arrays directly instead of copying them on
  // every read.
  const validated = freezeDeep(overlaySlices(validateConfig(options.schema, materialized), options.slices))
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
 * Places every published slice's values into the root tree at the namespace it owns.
 *
 * Without this, declaring an application schema *removes* the framework's configuration from the root: slices
 * read the materialized tree, the root handle reads the validated one, and validation drops every key the
 * schema does not declare. So an application that described its own settings would find `ctx.config.server`
 * gone, along with `$i.value(c => c.server.port)`.
 *
 * Values rather than a composed schema, because a schema may be `$t` or any Standard Schema and the two cannot
 * be merged. Each subtree is therefore validated exactly once, by the feature that owns it.
 *
 * What the application declared wins any overlap, and the two cannot disagree anyway: a schema's declared
 * defaults are published into the `SCHEMA` band, so the slice resolved from the same merged tree.
 */
function overlaySlices<T>(validated: T, slices: readonly ConfigSliceSpec[] | undefined): T {
  if (slices === undefined || slices.length === 0 || !isRecord(validated)) {
    return validated
  }

  // Cloned before anything is written. Under `passthroughConfigSchema` the validated tree *is* the materialized
  // one — the standard-schema branch hands its input straight back — and that object is what every slice read
  // from.
  const tree = cloneTree(validated) as Record<string, unknown>

  // Shallowest first, so a slice nested inside another's namespace (`auth.schemes.jwt` under `auth`) is written
  // after its parent instead of being erased by it.
  const ordered = [...slices].sort((a, b) => a.parts.length - b.parts.length)

  for (const spec of ordered) {
    // A slice spanning the whole tree would replace the application's own, and one that failed to resolve has
    // nothing to place — start-up fails for it separately.
    if (spec.parts.length === 0 || !spec.slice.published) {
      continue
    }

    const parts = [...spec.parts]
    setByPath(tree, parts, mergeUnder(readByParts(tree, parts), spec.slice.snapshot()))
  }

  return tree as T
}

/**
 * Fills `incoming`'s keys in behind `existing`'s, so what the application declared is never overwritten.
 *
 * Everything is copied on the way in. A slice publishes a deep-frozen value, and a feature that nests slices
 * inside its own namespace — authentication registers `auth` alongside `auth.schemes.*` — needs to write into
 * the object its parent just placed.
 */
function mergeUnder(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing) || !isRecord(incoming)) {
    return cloneTree(existing === undefined ? incoming : existing)
  }

  const merged: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = cloneTree(value)
  }

  for (const [key, value] of Object.entries(existing)) {
    merged[key] = mergeUnder(value, incoming[key])
  }

  return merged
}

/**
 * Copies the containers, not their contents.
 *
 * Only plain objects and arrays are rebuilt; anything else is carried across by reference, so a value a schema
 * transformed into a class instance keeps its identity and its prototype.
 */
function cloneTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneTree)
  }

  if (!isRecord(value)) {
    return value
  }

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = cloneTree(child)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Validates each feature slice and hands it to its holder.
 *
 * Slices read from the **materialized** tree rather than the root-validated one on purpose: both zod's
 * `.object()` and TypeBox's `Value.Clean` drop keys the schema does not declare, so a feature namespace the
 * application never described would be stripped before the feature ever saw it. The root schema governs the
 * application's own config key; a slice governs itself.
 *
 * A namespace that resolves to nothing validates as an empty object, which lets the feature's own schema
 * defaults — and the framework-band values written beneath it — decide the outcome instead of failing.
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
      const raw = readByParts(materialized, spec.parts) ?? {}
      // Publishing also runs this slice's derivations, so a derivation that rejects the combination as a whole
      // is caught by the same guard as a field that failed to validate.
      spec.slice.publish(freezeDeep(validateConfig(spec.schema, raw)))
    } catch (error) {
      spec.slice.fail(error)
      failures.push({ path: spec.parts.join('.') || '<root>', error })
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
