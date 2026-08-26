import { $t } from '@caffeinejs/std'

/** The default location of the view settings in the configuration tree. Engines sit beneath it by name. */
export const VIEW_CONFIG_NAMESPACE: readonly string[] = ['view']

/**
 * The part of `@fastify/view`'s options one engine can take from a configuration tree.
 *
 * `engine` is the notable omission: it is a module object full of functions, and a function cannot go
 * through the tree at all — `Value.Convert` cannot clone one. `options` is left out for the same reason,
 * since an engine's own options routinely carry helpers. Both stay on the builder and are merged back once
 * the slice publishes.
 */
export interface ViewConfig {
  root?: string | string[]
  viewExt?: string
  layout?: string
  defaultContext?: Record<string, unknown>
  production?: boolean
  includeViewExtension?: boolean
  charset?: string
  maxCache?: number
  templates?: string[]
}

/**
 * The keys {@link ViewConfig} declares, used to split what the builder holds into the half that can travel
 * through the tree and the half that cannot. Split by *declared key* rather than by "is it a function",
 * because `engine` is an object whose members are functions — it would pass a typeof test and then fail to
 * clone.
 */
export const VIEW_CONFIG_KEYS: readonly (keyof ViewConfig)[] = [
  'root',
  'viewExt',
  'layout',
  'defaultContext',
  'production',
  'includeViewExtension',
  'charset',
  'maxCache',
  'templates',
]

/** The schema governing one engine's slice. Nothing is defaulted — `@fastify/view` owns its own defaults. */
export const viewConfigSchema = $t.Object({
  root: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
  viewExt: $t.Optional($t.String()),
  layout: $t.Optional($t.String()),
  defaultContext: $t.Optional($t.Record($t.String(), $t.Unknown())),
  production: $t.Optional($t.Boolean()),
  includeViewExtension: $t.Optional($t.Boolean()),
  charset: $t.Optional($t.String()),
  maxCache: $t.Optional($t.Number()),
  templates: $t.Optional($t.Array($t.String())),
})
