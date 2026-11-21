import type { RouteOptions } from '@caffeinejs/http'

import type { CacheControlOptions } from '../cache_control.js'

declare module '@caffeinejs/http' {
  interface RouteOptions {
    /** Read by the caching plugin: this route's cache settings, or `false` to turn caching off for it. */
    cache?: CacheControlOptions | false
  }
}

/**
 * Caches the route's response, or turns caching off for it with `false`.
 *
 * Needs the caching plugin installed (`.with(HTTPCaching())`); this is the per-route half of it, applied with
 * `.options(cacheControl(...))` on a route or `.routeOptions(cacheControl(...))` on a router. The decorator form is
 * {@link CacheControl}.
 */
export function cacheControl(options: CacheControlOptions | false = {}): Partial<RouteOptions> {
  return { cache: options }
}
