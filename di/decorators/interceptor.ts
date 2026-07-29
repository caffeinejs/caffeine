import { PostResolutionInterceptor } from '../post_resolution_interceptor.js'
import { Ctor } from '../types.js'
import { notNil } from '../internal/util/assert/not_nil.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'

/**
 * Attaches a post-resolution interceptor. Called with the resolved instance; can wrap or replace it.
 *
 * @param interceptor - `PostResolutionInterceptor` function.
 *
 * @example
 * ```ts
 * @Interceptor(instance => new Proxy(instance, handler))
 * @Injectable()
 * class UserService {}
 * ```
 */
export function Interceptor<T>(interceptor: PostResolutionInterceptor<T>) {
  notNil(interceptor, `@${Interceptor.name}(): parameter interceptor is required.`)

  return function <TFunction extends Function>(target: TFunction | object, context: DecoratorContext) {
    const parsed = notNil(interceptor)

    if (context.kind === 'class') {
      extendInjectableAttributes<T>(context.metadata, target as Ctor, config => config.interceptor(parsed))
      return
    }

    extendMemberInjectableAttributes(context.metadata, context.name, config => config.interceptor(parsed))
  }
}
