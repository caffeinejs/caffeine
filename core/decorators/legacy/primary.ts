import { Ctor } from '../../types.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Marks a binding as the preferred candidate when multiple implementations qualify for injection.
 *
 * @example
 * ```ts
 * @Primary()
 * @Injectable()
 * class PostgresUserRepo implements UserRepo {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Primary(): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.primary(true))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.primary(true))
    }
  }
}
