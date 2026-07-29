import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Skips all post-processors for this component during resolution.
 *
 * @example
 * ```ts
 * @ByPassPostProcessors()
 * @Injectable()
 * class InternalService {}
 * ```
 */
export function ByPassPostProcessors() {
  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.byPassPostProcessors()),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.byPassPostProcessors()),
  )
}
