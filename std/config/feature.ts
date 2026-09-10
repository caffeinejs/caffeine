import type { ConfigSchema, FeatureConfigKey, ConfigEntry, ConfigValue, PropertySource } from './config.js'
import type { ConfigDefinition } from './definition.js'
import { mergeSources } from './engine.js'
import { flattenObject } from './flatten.js'
import { materialize } from './materializer.js'
import { selectorPath } from './selector_path.js'
import type { ConfigSlice } from './slice.js'

/**
 * What a feature needs to resolve its settings.
 *
 * `defaults` and `values` are the two bands a feature owns. Both are `unknown`-valued rather than
 * {@link ConfigValue}-valued, because that type never fit what features actually hold: an interface has no
 * index signature, so neither `ServerOptions` nor a third-party bag like `@fastify/static`'s options satisfies
 * it however plain its members are, and every feature would open with a cast.
 *
 * Nothing is lost by widening, because the type was never the guard here. Whatever is written is put through
 * the slice's schema, and it is `Value.Clean` and `Value.Check` that decide what a feature ends up reading — a
 * stray function in a declared field is stripped or rejected there, not by this signature.
 */
export interface FeatureConfigSpec<T> {
  /**
   * The location recorded by the builder's `.config(...)`, when the application called it — `s.config(c =>
   * c.app.server)` puts the settings at `app.server.*`.
   *
   * Omitted, the slice is **detached**: it resolves from `defaults` and `values` alone, reads nothing from the
   * configuration tree, and contributes nothing to it. A feature is never placed somewhere the application did
   * not ask for.
   */
  selector?: (c: never) => unknown
  /**
   * Publishes this slice under a key, so code holding no builder can read it — `config(kHTMLConfig)` on the
   * configuration handle. Omit it for a feature whose settings nothing outside its own builder reads.
   */
  key?: FeatureConfigKey<T>
  schema: ConfigSchema<T>
  /** `FRAMEWORK` band — the bottom of the chain. Everything overrides these. */
  defaults?: Record<string, unknown>
  /** `CODE` band — what the builder methods set. `undefined` entries are skipped, never written as null. */
  values?: Record<string, unknown>
}

/**
 * Registers a feature's configuration and returns the slice its resolved value is published into.
 *
 * The shape every feature follows: resolve where the settings live, write the framework defaults and the
 * builder's code-set values into their bands, then register the slice that reads the merged result. A feature's
 * `configure()` is left with its bindings and nothing else.
 *
 * **Calling this is what makes a slice live.** A slice is registered because the builder ran, never because the
 * tree happens to contain a matching key — so configuration alone can never activate a feature the application
 * did not ask for. It parameterizes what is already switched on.
 *
 * Where the settings live is the application's choice and nothing else's. With a selector, the feature joins
 * the tree at the path the application named, which is what puts files, the environment and the command line
 * over its defaults. Without one it resolves detached, off `defaults` and `values` — the feature works, it
 * simply has no external overrides and adds no field to the application's configuration object.
 *
 * Both bands are written key by key, because {@link MutableConfigProvider.set} clears everything under the path
 * it writes: a whole-object write would have each key erase the last, and would give the last feature
 * registered at a location the whole default block.
 *
 * The two paths resolve the same way. A detached feature merges its own two bands through the merge the tree
 * itself goes through, so where a feature was pointed decides where its *overrides* come from and never what
 * its own inputs add up to.
 *
 * The returned slice's {@link ConfigSlice.config} is what the feature hands to whatever it constructs or binds,
 * in `bootstrap`.
 */
export function defineFeatureConfig<T>(definition: ConfigDefinition, spec: FeatureConfigSpec<T>): ConfigSlice<T> {
  const values = definedValues(spec.values)
  const parts = spec.selector === undefined ? undefined : selectorPath(spec.selector)

  const slice =
    parts === undefined
      ? definition.slice(undefined, spec.schema, detachedValues(spec.defaults, values))
      : mappedSlice(definition, parts, spec, values)

  if (spec.key !== undefined) {
    definition.publishFeature(spec.key, slice)
  }

  return slice
}

function mappedSlice<T>(
  definition: ConfigDefinition,
  parts: readonly string[],
  spec: FeatureConfigSpec<T>,
  values: Record<string, unknown>,
): ConfigSlice<T> {
  for (const [key, value] of Object.entries(spec.defaults ?? {})) {
    definition.frameworkDefaults.set([...parts, key], value as ConfigValue)
  }

  for (const [key, value] of Object.entries(values)) {
    definition.codeValues.set([...parts, key], value as ConfigValue)
  }

  return definition.slice(parts, spec.schema)
}

/**
 * The object a detached feature validates.
 *
 * The same flatten and merge the configuration tree goes through, over the feature's own two bands and nothing
 * else — so a detached feature still reads no file, environment variable or argument, and still adds no field
 * to the application's configuration. What it gains is that its defaults and its builder values merge leaf by
 * leaf: a builder setting one field of a nested block no longer loses that block's other defaults for want of
 * a location.
 */
function detachedValues(
  defaults: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  // Highest band first — the merge is first-wins, the order the engine is handed the real bands in.
  const sources = [band('feature:code', values), band('feature:defaults', defaults ?? {})]

  return materialize({ sources, values: mergeSources(sources) })
}

function band(name: string, values: Record<string, unknown>): PropertySource {
  const entries = new Map<string, ConfigEntry>()
  flattenObject(values, name, '', entries)

  return { name, entries }
}

/**
 * Drops the entries a builder never set.
 *
 * A builder method that was never called leaves `undefined` behind. Writing it would put a null in the tree,
 * which is a value — and a value beats the framework default it was supposed to leave alone.
 */
function definedValues(values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(values ?? {})) {
    if (value !== undefined) {
      out[key] = value
    }
  }

  return out
}
