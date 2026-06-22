import { PostResolutionInterceptor } from '../../../post_resolution_interceptor.js'
import { ResolutionContext } from '../../../resolution_context.js'

export function postConstructInterceptor<T>(): PostResolutionInterceptor<T> {
  return (ctx: ResolutionContext, instance: T): T => {
    if (instance === null || instance === undefined || ctx.binding.postConstruct === undefined) {
      return instance
    }

    ctx.binding.postConstruct(instance)

    return instance
  }
}
