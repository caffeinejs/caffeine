import type { ConfigDefinition } from './definition.js'
import type { FeatureConfigKey } from './feature_key.js'
import type { ConfigSchema } from './schema.js'
import { selectorPath } from './selector_path.js'
import type { ConfigSlice } from './slice.js'
import type { ConfigValue } from './types.js'

/** The name the unnamed instance of a multi-instance feature is addressed by. */
export const DEFAULT_INSTANCE = 'default'

/**
 * Where one instance of a multi-instance feature keeps its settings.
 *
 * Every instance is addressed by name, the unnamed one as {@link DEFAULT_INSTANCE} — so `.extend(kafka, …)` reads
 * `kafka.default.*` and `.extend(kafka('orders'), …)` reads `kafka.orders.*`. Uniform on purpose: letting the
 * unnamed instance sit flat at `kafka.*` would put settings and instance names in one object, where `kafka.orders`
 * is a setting or an instance depending on nothing the schema can express.
 */
export function instanceNamespace(base: readonly string[], name?: string): readonly string[] {
  return [...base, name ?? DEFAULT_INSTANCE]
}

/**
 * What a feature needs to place its settings in the configuration tree.
 *
 * `defaults` and `values` are the two bands a feature owns. Both are `unknown`-valued rather than
 * {@link ConfigValue}-valued, because that type never fit what features actually hold: an interface has no
 * index signature, so neither `ServerOptions` nor a third-party bag like `@fastify/static`'s options satisfies
 * it however plain its members are, and every feature would open with a cast.
 *
 * Nothing is lost by widening, because the type was never the guard here. Whatever is written is materialized
 * and put through the slice's schema, and it is `Value.Clean` and `Value.Check` that decide what a feature
 * ends up reading — a stray function in a declared field is stripped or rejected there, not by this signature.
 */
export interface FeatureConfigSpec<T> {
  /** Default location, e.g. `['server']` or `instanceNamespace(['kafka'], name)`. */
  namespace: readonly string[]
  /** The selector recorded by the builder's `.config(...)`, when it was called. Wins over `namespace`. */
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
 * Registers a feature's slice of the configuration tree and returns it.
 *
 * The shape every feature follows: resolve where the settings live, write the framework defaults and the
 * builder's code-set values into their bands, then register the slice that reads the merged result. A feature's
 * `configure()` is left with its bindings and nothing else.
 *
 * **Calling this is what makes a namespace live.** A slice is registered because the builder ran, never because
 * the tree happens to contain a matching key — so configuration alone can never activate a feature the
 * application did not ask for. It parameterizes what is already switched on.
 *
 * The two bands are written at different granularity, and that is load-bearing. `defaults` goes in as one
 * object so it lands as a unit; `values` goes in key by key, because {@link MutableConfigProvider.set} clears
 * everything under the path it writes and a single whole-object write would have each key erase the last.
 */
export function defineFeatureConfig<T>(definition: ConfigDefinition, spec: FeatureConfigSpec<T>): ConfigSlice<T> {
  const parts = spec.selector === undefined ? spec.namespace : selectorPath(spec.selector)

  if (spec.defaults !== undefined) {
    definition.frameworkDefaults.set(parts, spec.defaults as ConfigValue)
  }

  for (const [key, value] of Object.entries(spec.values ?? {})) {
    // A builder method that was never called leaves `undefined` behind. Writing it would put a null in the
    // tree, which is a value — and a value beats the framework default it was supposed to leave alone.
    if (value !== undefined) {
      definition.codeValues.set([...parts, key], value as ConfigValue)
    }
  }

  const slice = definition.slice(parts, spec.schema)

  if (spec.key !== undefined) {
    definition.publishFeature(spec.key, slice)
  }

  return slice
}
