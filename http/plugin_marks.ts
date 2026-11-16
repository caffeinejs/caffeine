// Marks and names the server reads off the plugins it is given: which adapter a built-in runs on, while the Fastify
// adapter and the engine both exist, and the one plugin of another package it must recognize. Read by path, never
// through a barrel: no application marks a plugin.

/** What a Fastify application says when handed an engine-only plugin. */
export interface EngineOnly {
  /** The factory the refusal names: `csrf` for `csrf()`. */
  readonly factory: string
  /** The refusal's one solution: what to use on Fastify instead. */
  readonly instead: string
}

/** On an `HTTPPlugin` that runs on the engine alone: an {@link EngineOnly}. */
export const kEngineOnly: unique symbol = Symbol('caffeine.http.engine-only')

/** On a Fastify plugin function Caffeine returns: the name the engine exports in its place. */
export const kFastifyOnly: unique symbol = Symbol('caffeine.http.fastify-only')

/**
 * The name `@caffeinejs/caching` registers its plugin under.
 *
 * The one place this package names another: `@CacheControl` / `@CacheInvalidate` and the plugin that serves them
 * ship together, so a route carrying the config with no plugin to read it is a missing `.with(HTTPCaching())`
 * and nothing else.
 */
export const CACHING_PLUGIN = '@caffeinejs/caching'
