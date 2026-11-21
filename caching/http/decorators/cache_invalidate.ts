import { ErrConfiguration, RouteOptions } from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/err'

import type { CacheInvalidateOptions } from '../cache_invalidate.js'
import { cacheInvalidate } from '../helpers/cache_invalidate.js'

/**
 * Evicts every entry stored under any of `tags` after a successful mutating request on the decorated route.
 *
 * The programmatic form is {@link cacheInvalidate}.
 *
 * @throws ErrConfiguration on a class: every route of the controller would evict, its reads included.
 */
export function CacheInvalidate(
  options: CacheInvalidateOptions,
): (fn: Function, context: ClassMemberDecoratorContext) => void {
  const decorate = RouteOptions(cacheInvalidate(options))

  return (fn, context) => {
    if ((context as DecoratorContext).kind === 'class') {
      throw new ErrConfiguration(
        errMessage(`Cannot apply @CacheInvalidate to the class "${String(context.name)}": it decorates a method`)
          .solutions('Put @CacheInvalidate on each method that mutates')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    decorate(fn, context)
  }
}
