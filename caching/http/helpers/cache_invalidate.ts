import type { RouteOptions } from '@caffeinejs/http'

import type { CacheInvalidateOptions } from '../cache_invalidate.js'

declare module '@caffeinejs/http' {
  interface RouteOptions {
    /** Read by the caching plugin: the tags this route evicts after a successful mutating request. */
    cacheInvalidate?: CacheInvalidateOptions | false
  }
}

/**
 * Evicts every entry stored under any of `tags` after a successful mutating request, applied with
 * `.config(cacheInvalidate(...))` on a route. The decorator form is {@link CacheInvalidate}.
 *
 * Set on the route that mutates: under `router.config(...)` it covers every route of the router, and a read
 * evicts too.
 */
export function cacheInvalidate(options: CacheInvalidateOptions): Partial<RouteOptions> {
  return { cacheInvalidate: options }
}
