import { ResolutionContext } from './resolution_context.js'

/**
 * PostResolutionInterceptor defines an interceptor function that is called after the instance is resolved.
 * It allows modifying the instance before it is returned.
 *
 * @param ctx - The {@link ResolutionContext} object.
 * @param instance - The actual instance to be intercepted.
 */
export type PostResolutionInterceptor<T = any> = (ctx: ResolutionContext, instance: T) => T
