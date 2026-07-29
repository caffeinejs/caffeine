import { ErrInvalidDecorator } from '../errors.js'
import { extendMemberInjectableAttributes } from './registrar/index.js'
import { Provides } from './provides.js'
import { Configuration } from './configuration.js'

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
 */
export function Async() {
  return function (_target: Function, context: DecoratorContext) {
    if (context.kind !== 'method') {
      throw new ErrInvalidDecorator(
        `@${Async.name} can only be applied to methods: use it on a method decorated with @${Provides.name} inside a @${Configuration.name} class`,
      )
    }

    extendMemberInjectableAttributes(context.metadata, context.name, config => config.async())
  }
}
