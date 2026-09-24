import type { AnyRouteExtension } from '@caffeinejs/http'

import type { CacheInvalidateOptions } from '../cache_invalidate.js'
import type { ConfigTarget } from './_config_target.js'

/**
 * Evicts every entry stored under any of `tags` after a successful mutating request. The decorator form is
 * {@link CacheInvalidate}.
 */
export function cacheInvalidate(options: CacheInvalidateOptions): AnyRouteExtension {
  return (target: ConfigTarget) => {
    target.config('cacheInvalidate', options)
  }
}
