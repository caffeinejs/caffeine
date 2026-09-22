import { configureRoute, configureRouteGroup } from '@caffeinejs/http'

import type { CacheControlOptions } from '../cache.js'
import type { CacheInvalidateOptions } from '../cache_invalidate.js'
import { cacheControl, cacheInvalidate } from '../helpers/index.js'

/**
 * Caches responses for a controller or a single route, or turns caching off with `false`.
 *
 * The programmatic form is {@link cacheControl}.
 */
export function CacheControl(options: CacheControlOptions | false = {}) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, cacheControl(options))
    } else {
      configureRoute(context, cacheControl(options))
    }
  }
}

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
