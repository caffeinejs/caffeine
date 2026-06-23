import { Ctor } from '../../types.js'
import { Identifier } from '../../key.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Assigns one or more named identifiers to a binding, enabling resolution by name.
 *
 * @param name - First identifier (required).
 * @param names - Additional identifiers.
 *
 * @example
 * ```ts
 * @Named('primary')
 * @Injectable()
 * class MainDataSource {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Named(
  name: Identifier,
  ...names: Identifier[]
): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.names([name, ...names]))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.names([name, ...names]))
    }
  }
}
