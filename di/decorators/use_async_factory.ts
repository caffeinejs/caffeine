import { AsyncFactory, Factory } from '../factory.js'
import { notNil } from '../internal/util/assert/not_nil.js'
import { Ctor } from '../types.js'
import { extendInjectableAttributes } from './registrar/index.js'

/**
 * Replaces the constructor with an async factory function. The container awaits the result.
 * Note that async provided bindings can only be singleton or refresh scoped.
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
 */
export function UseAsyncFactory<T>(factory: AsyncFactory<T>) {
  notNil(factory, `@${UseAsyncFactory.name}(): parameter factory is required.`)

  return function (target: Ctor, context: ClassDecoratorContext) {
    extendInjectableAttributes<T>(context.metadata, target, config =>
      config.async(true).factory(factory as unknown as Factory<T>),
    )
  }
}
