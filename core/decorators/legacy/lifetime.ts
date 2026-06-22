import { Ctor } from '../../types.js'
import { Identifier } from '../../key.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Registers the component with a custom scope identified by `scopeId`.
 *
 * Sets the scope that controls instance sharing for this component.
 *
 * @param scopeId - Identifier of the scope.
 *
 * @example
 * ```ts
 * const REQUEST = Symbol('request')
 *
 * @Lifetime(REQUEST)
 * @Injectable()
 * class RequestService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Lifetime(
  scopeId: Identifier,
): (target: object | Function, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.scope(scopeId))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.scope(scopeId))
    }
  }
}
