import { PostResolutionInterceptor } from '../../../post_resolution_interceptor.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Factory } from '../../../factory.js'

export function chainedFactory<T>(baseFactory: Factory<T>, interceptors: PostResolutionInterceptor[]): Factory<T> {
  const chain = interceptors.reduce<(ctx: ResolutionContext, result: T) => T>(
    (prev, interceptor) => (ctx, result) => interceptor(ctx, prev(ctx, result)),
    (_ctx, result) => result,
  )

  return (ctx: ResolutionContext): T => chain(ctx, baseFactory(ctx))
}
