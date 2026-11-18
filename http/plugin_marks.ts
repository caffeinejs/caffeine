// Names the server reads off the plugins it is given: the one plugin of another package it must recognize. Read by
// path, never through a barrel: no application marks a plugin.

/**
 * The name `@caffeinejs/caching` registers its plugin under.
 *
 * The one place this package names another: `@CacheControl` / `@CacheInvalidate` and the plugin that serves them
 * ship together, so a route carrying the config with no plugin to read it is a missing `.with(HTTPCaching())`
 * and nothing else.
 */
export const CACHING_PLUGIN = '@caffeinejs/caching'
