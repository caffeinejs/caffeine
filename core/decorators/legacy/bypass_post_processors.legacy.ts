import { Ctor } from '../../types.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Skips all post-processors for this component during resolution.
 *
 * @example
 * ```ts
 * @ByPassPostProcessors()
 * @Injectable()
 * class InternalService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function ByPassPostProcessors(): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.byPassPostProcessors(true))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.byPassPostProcessors(true))
    }
  }
}
