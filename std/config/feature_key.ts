declare const kFeatureConfigType: unique symbol
declare const kFeatureConfigNeedsType: unique symbol

/** Phantom brand that attaches a config type to a feature key without a runtime object. */
export interface FeatureConfigBrand<in out T> {
  readonly [kFeatureConfigType]: T
}

type FeatureConfigNeedsTypeArg = { readonly [kFeatureConfigNeedsType]: true }

/**
 * A symbol branded with the configuration it addresses. The return value is the plain symbol; `T` exists only
 * at the type level.
 */
export type FeatureConfigKey<T> = symbol & FeatureConfigBrand<T>

/**
 * Names a feature's configuration, so code that does not own the builder can read it.
 *
 * A feature's slice is reachable from its builder and nowhere else, which leaves anything downstream — a
 * `Responder`, a middleware, a helper handed only a request context — with no route to it. A key closes that:
 * the feature registers its slice under one, and a reader resolves it through the configuration handle.
 *
 * Addressing by key rather than by namespace is what survives relocation. A feature's `.config(c => c.app.html)`
 * moves its settings, so the path is not something a reader can hard-code; the key does not move.
 *
 * The type argument is required: without it the key is unusable, so a missing one is a compile error at the
 * declaration rather than an `unknown` that spreads to every read site.
 *
 * ```ts
 * export const kHTMLConfig = featureConfigKey<HTMLDefaults>('html')
 * ```
 */
export function featureConfigKey<T = never>(
  description: string,
): [T] extends [never] ? FeatureConfigNeedsTypeArg : FeatureConfigKey<T> {
  return Symbol(description) as never
}
