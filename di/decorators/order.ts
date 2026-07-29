import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Sets the position of this binding when injected as part of an ordered collection via {@link ordered}.
 * Lower values come first. Bindings without an order value are placed last.
 *
 * @param order - Integer position. Lower values sort first.
 *
 * @example
 * ```ts
 * @Order(1)
 * @Injectable()
 * class HighPriorityHandler implements Handler {}
 *
 * @Order(2)
 * @Injectable()
 * class LowPriorityHandler implements Handler {}
 *
 * @Injectable([$i.ordered(Handler)])
 * class Pipeline {
 *   constructor(readonly handlers: Handler[]) {} // [HighPriorityHandler, LowPriorityHandler]
 * }
 * ```
 */
export function Order(order: number) {
  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.order(order)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.order(order)),
  )
}
