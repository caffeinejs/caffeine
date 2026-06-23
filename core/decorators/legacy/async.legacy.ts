import { ErrInvalidDecorator } from '../../errors.js'
import { extendMemberInjectableAttributes } from '../registrar/index.js'
import { Provides } from './provides.legacy.js'
import { Configuration } from './configuration.legacy.js'

/**
 * Marks a `@Provides` method as async. The container awaits the returned promise before injecting.
 *
 * Must be applied to a method inside a `@Configuration` class that is also decorated with `@Provides`.
 *
 * @example
 * ```ts
 * @Configuration()
 * class AppConfig {
 *   @Async()
 *   @Provides(Database)
 *   async database(): Promise<Database> {
 *     return Database.connect()
 *   }
 * }
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Async() {
  return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    if (typeof descriptor?.value !== 'function') {
      throw new ErrInvalidDecorator(
        `@${Async.name} can only be applied to methods: use it on a method decorated with @${Provides.name} inside a @${Configuration.name} class`,
      )
    }

    extendMemberInjectableAttributes(target, propertyKey, config => config.async(true))
  }
}
