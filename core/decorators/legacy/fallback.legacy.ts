import { Ctor } from '../../types.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Marks a binding as the last-resort candidate, used only when no other binding qualifies.
 *
 * @example
 * ```ts
 * @Fallback()
 * @Injectable()
 * class NoopLogger implements Logger {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Fallback(): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.fallback(true))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.fallback(true))
    }
  }
}
