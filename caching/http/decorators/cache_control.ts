import { RouteOptions } from '@caffeinejs/http'

import type { CacheControlOptions } from '../cache_control.js'
import { cacheControl } from '../helpers/cache_control.js'

/**
 * Caches responses for a controller or a single route, or turns caching off with `false`.
 *
 * The programmatic form is {@link cacheControl}.
 */
export function CacheControl(options: CacheControlOptions | false = {}) {
  return RouteOptions(cacheControl(options))
}
