import { Ctor } from '../../types.js'
import { AsyncFactory } from '../../factory.js'
import { extendInjectableAttributes } from '../registrar/index.js'

/**
 * Replaces the constructor with an async factory function. The container awaits the result.
 *
 * @param factory - Async factory function returning a promise of the instance.
 *
 * @example
 * ```ts
 * @UseAsyncFactory(async () => {
 *   const db = await Database.connect()
 *   return new UserService(db)
 * })
 * @Injectable()
 * class UserService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function UseAsyncFactory<T>(factory: AsyncFactory<T>): (target: Function) => void {
  return (target: Function) => {
    extendInjectableAttributes(target, target as Ctor, config => config.factory(factory).async(true))
  }
}
