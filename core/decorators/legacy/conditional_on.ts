import { Ctor } from '../../types.js'
import { Conditional } from '../../conditional.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Registers the component conditionally. The predicate is evaluated at container
 * initialization; the binding is skipped if it returns `false`.
 *
 * @param conditional - Predicate receiving the resolution context.
 *
 * @example
 * ```ts
 * @ConditionalOn(ctx => ctx.has(FeatureFlags))
 * @Injectable()
 * class ExperimentalService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function ConditionalOn(
  conditional: Conditional,
): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.conditional(conditional))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.conditional(conditional))
    }
  }
}
