import { configureRoute, type Duration } from '@caffeinejs/http'
import { configureRouter } from '@caffeinejs/http/decorators/registrar'
import { CacheOptions } from '../cache/types.js'

export type { Duration }
export type { CacheOptions } from '../cache/types.js'

export function Cache(options: CacheOptions | false = {}) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.config('cache', options))
    } else {
      configureRoute(context, spec => spec.config('cache', options))
    }
  }
}
