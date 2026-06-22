import { Identifier } from '../../../key.js'
import { PostResolutionInterceptor } from '../../../post_resolution_interceptor.js'
import { ResolutionContext } from '../../../resolution_context.js'

export function methodInjectorInterceptor<T>(): PostResolutionInterceptor<T> {
  return (ctx: ResolutionContext, instance: T): T => {
    if (instance === null || instance === undefined) {
      return instance
    }

    for (const [method, resolvers] of ctx.binding.methodResolvers) {
      const deps = new Array(resolvers.length)

      for (let i = 0; i < resolvers.length; i++) {
        deps[i] = resolvers[i]()
      }

      ;(instance as Record<Identifier, (...args: unknown[]) => void>)[method](...deps)
    }

    return instance
  }
}
