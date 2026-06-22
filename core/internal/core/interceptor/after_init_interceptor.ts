import { PostProcessor } from '../../../post_processor.js'
import { PostResolutionInterceptor } from '../../../post_resolution_interceptor.js'
import { ResolutionContext } from '../../../resolution_context.js'

export function afterInitInterceptor<T>(postProcessor: PostProcessor): PostResolutionInterceptor<T> {
  return (ctx: ResolutionContext, instance: T): T => postProcessor.afterInit(ctx, instance) as T
}
