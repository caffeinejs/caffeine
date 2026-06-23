import { Ctor } from '../../types.js'
import { Factory } from '../../factory.js'
import { extendInjectableAttributes } from '../registrar/index.js'

/**
 * Replaces the constructor with a custom factory function for instantiation.
 *
 * @param factory - Factory function returning the instance.
 *
 * @example
 * ```ts
 * @UseFactory(() => new UserService({ timeout: 5000 }))
 * @Injectable()
 * class UserService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function UseFactory<T>(factory: Factory<T>): (target: Function) => void {
  return (target: Function) => {
    extendInjectableAttributes(target, target as Ctor, config => config.factory(factory))
  }
}
