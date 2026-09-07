import type { ConfigDefinition } from './definition.js'
import type { FeatureConfigKey } from './feature_key.js'
import type { ConfigSchema } from './schema.js'
import { selectorPath } from './selector_path.js'
import type { ConfigSlice } from './slice.js'
import type { ConfigValue } from './types.js'

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
 * The two bands are written at different granularity, and that is load-bearing. `defaults` goes in as one
 * object so it lands as a unit; `values` goes in key by key, because {@link MutableConfigProvider.set} clears
 * everything under the path it writes and a single whole-object write would have each key erase the last.
 */
export function defineFeatureConfig<T>(definition: ConfigDefinition, spec: FeatureConfigSpec<T>): ConfigSlice<T> {
  const values = definedValues(spec.values)
  const parts = spec.selector === undefined ? undefined : selectorPath(spec.selector)

  const slice =
    parts === undefined
      ? definition.slice(undefined, spec.schema, { ...spec.defaults, ...values })
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
  if (spec.defaults !== undefined) {
    definition.frameworkDefaults.set(parts, spec.defaults as ConfigValue)
  }

  for (const [key, value] of Object.entries(values)) {
    definition.codeValues.set([...parts, key], value as ConfigValue)
  }

  return definition.slice(parts, spec.schema)
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
