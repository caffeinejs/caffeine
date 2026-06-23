import { Ctor } from '../../types.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Defers instantiation of the component until it is first accessed.
 *
 * @param lazy - Pass `false` to disable lazy loading. Defaults to `true`.
 *
 * @example
 * ```ts
 * @Lazy()
 * @Injectable()
 * class HeavyService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Lazy(lazy = true): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.lazy(lazy))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.lazy(lazy))
    }
  }
}
