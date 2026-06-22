import { Key } from '../../key.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Attaches one or more symbol labels to a binding for multi-injection filtering.
 *
 * @param label - First label symbol (required).
 * @param labels - Additional label symbols.
 *
 * @example
 * ```ts
 * const PLUGIN = Symbol('plugin')
 *
 * @Label(PLUGIN)
 * @Injectable()
 * class AuthPlugin {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Label(
  label: symbol,
  ...labels: symbol[]
): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Key<unknown>, config => config.labels([label, ...labels]))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.labels([label, ...labels]))
    }
  }
}
