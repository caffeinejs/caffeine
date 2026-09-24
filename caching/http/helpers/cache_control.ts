import type { AnyRouteExtension } from '@caffeinejs/http'

import type { CacheControlOptions } from '../cache_control.js'
import type { ConfigTarget } from './_config_target.js'

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
