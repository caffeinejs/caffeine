import { Identifier } from '../../../key.js'
import { PostResolutionInterceptor } from '../../../post_resolution_interceptor.js'
import { ResolutionContext } from '../../../resolution_context.js'

export function propertyInjectorInterceptor<T>(): PostResolutionInterceptor<T> {
  return (ctx: ResolutionContext, instance: T): T => {
    if (instance === null || instance === undefined) {
      return instance
    }

    for (const [prop, resolver] of ctx.binding.propertyResolvers) {
      ;(instance as Record<Identifier, unknown>)[prop] = resolver()
    }

    return instance
  }
}
