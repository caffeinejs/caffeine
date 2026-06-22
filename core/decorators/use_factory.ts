import { Factory } from '../factory.js'
import { Ctor } from '../types.js'
import { notNil } from '../internal/util/assert/not_nil.js'
import { extendInjectableAttributes } from './registrar/index.js'

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
 */
export function UseFactory<T>(factory: Factory<T>) {
  notNil(factory, `@${UseFactory.name}(): parameter factory is required.`)

  return function (target: Ctor, context: ClassDecoratorContext) {
    extendInjectableAttributes<T>(context.metadata, target,
      config => config.factory(factory),
    )
  }
}
