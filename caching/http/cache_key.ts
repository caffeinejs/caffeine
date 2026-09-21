import type { FastifyContextRequest } from '@caffeinejs/http'

import { buildCacheKey } from './_util.js'

/** What {@link cacheKey} reads from `options` instead of from the request. */
export interface CacheKeyOptions {
  /** Used instead of the request's method. `GET` and `HEAD` share one key. */
  method?: string
  /** Used instead of the request's URL. The query is included, and ordered the way the cache orders it. */
  url?: string
  /** The header names the cached route varies on, as its `@CacheControl({ vary })` lists them. */
  vary?: string[]
  /** Header values used instead of the request's, by lower-cased name. Read only for the names in `vary`. */
  headers?: Record<string, string>
}

/**
 * The key the cache stores a response under, derived the way the cache derives it.
 *
 * With no `options` it is the key of `req` itself on a route with no `vary`. `options` swap in what the entry
 * to reach was stored with, since the request evicting an entry is rarely the one that stored it:
 *
 * ```ts
 * // PUT /pets/:id evicts what GET /pets/:id and GET /pets stored
 * @CacheInvalidate({ key: req => [cacheKey(req, { method: 'GET' }), cacheKey(req, { method: 'GET', url: '/pets' })] })
 * ```
 *
 * An eviction reaches an entry only under the exact key it was stored with. A route whose `@CacheControl` has its
 * own `key` function is evicted with that function, not with this one.
 */
export function cacheKey(req: FastifyContextRequest, options?: CacheKeyOptions): string {
  const headers = options?.headers

  return buildCacheKey(
    (options?.method ?? req.method).toUpperCase(),
    options?.url ?? req.url,
    options?.vary,
    name => headers?.[name] ?? req.header(name),
  )
}
