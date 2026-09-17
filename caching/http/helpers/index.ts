import type { AnyRouteExtension } from '@caffeinejs/http'

import type { CacheControlOptions } from '../cache.js'
import type { CacheInvalidateOptions } from '../cache_invalidate.js'

type ConfigTarget = { config(key: string, value: unknown): unknown }

/**
 * Caches the route's response, or turns caching off for it with `false`.
 *
 * Needs the caching plugin installed (`.with(HTTPCaching())`); this is the per-route half of it. The
 * decorator form is {@link CacheControl}.
 */
export function cacheControl(options: CacheControlOptions | false = {}): AnyRouteExtension {
  return (target: ConfigTarget) => {
    target.config('cache', options)
  }
}

/**
 * Evicts cached entries after a successful mutating request. The decorator form is {@link CacheInvalidate}.
 */
export function cacheInvalidate(options: CacheInvalidateOptions = {}): AnyRouteExtension {
  return (target: ConfigTarget) => {
    target.config('cacheInvalidate', options)
  }
}
