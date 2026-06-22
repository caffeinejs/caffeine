import { Ctor } from '../../types.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from '../registrar/index.js'

/**
 * Attaches a key-value metadata tag to a binding.
 *
 * @param key - Symbol key.
 * @param value - Tag value.
 *
 * @example
 * ```ts
 * const PRIORITY = Symbol('priority')
 *
 * @Tag(PRIORITY, 10)
 * @Injectable()
 * class CriticalService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Tag(key: symbol, value: unknown): (target: object | Function, propertyKey?: string | symbol) => void {
  return (target: object | Function, propertyKey?: string | symbol) => {
    if (typeof target === 'function' && propertyKey === undefined) {
      extendInjectableAttributes(target, target as Ctor, config => config.tags(new Map([[key, value]])))
    } else {
      extendMemberInjectableAttributes(target as object, propertyKey!, config => config.tags(new Map([[key, value]])))
    }
  }
}
