import { CacheOptions } from '../cache/cache.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function Cache(options: CacheOptions | false = {}) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.config('cache', options))
    } else {
      configureRoute(context, spec => spec.config('cache', options))
    }
  }
}
