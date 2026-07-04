import { configureRoute } from '@caffeinejs/application'
import { CacheInvalidateOptions } from '../cache/types.js'

export type { CacheInvalidateOptions }

export function CacheInvalidate(options: CacheInvalidateOptions = {}) {
  return (_fn: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, spec => spec.config('cacheInvalidate', options))
  }
}
