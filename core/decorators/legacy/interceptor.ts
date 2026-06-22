import { Ctor } from '../../types.js'
import { PostResolutionInterceptor } from '../../post_resolution_interceptor.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

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
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Interceptor<T>(
  interceptor: PostResolutionInterceptor<T>,
): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.interceptor(interceptor))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.interceptor(interceptor))
    }
  }
}
