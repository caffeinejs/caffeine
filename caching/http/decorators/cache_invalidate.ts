import { configureRoute } from '@caffeinejs/http'

import type { CacheInvalidateOptions } from '../cache_invalidate.js'
import { cacheInvalidate } from '../helpers/cache_invalidate.js'

/**
 * Evicts every entry stored under any of `tags` after a successful mutating request on the decorated route.
 *
 * The programmatic form is {@link cacheInvalidate}.
 */
export function CacheInvalidate(options: CacheInvalidateOptions) {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, cacheInvalidate(options))
  }
}
