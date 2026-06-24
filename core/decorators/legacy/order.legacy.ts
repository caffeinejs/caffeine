import { Ctor } from '../../types.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

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
 * @Injectable([ordered(Handler)])
 * class Pipeline {
 *   constructor(readonly handlers: Handler[]) {} // [HighPriorityHandler, LowPriorityHandler]
 * }
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Order(order: number): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.order(order))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.order(order))
    }
  }
}
