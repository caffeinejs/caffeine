import { ErrInvalidDecorator } from '../errors.js'
import { Configuration } from './configuration.js'
import { extendMemberInjectableAttributes } from './registrar/index.js'

/**
 * Configures a pre-destroy callback for a bean produced by a `@Provides` method.
 * The function receives the produced instance and is called before the container is disposed.
 * The callback can be asynchronous.
 *
 * @param fn - Function to call with the produced instance on container disposal.
 *
 * @example
 * ```ts
 * @Configuration()
 * class AppConfig {
 *   @OnPreDestroy((conn: DbConnection) => conn.close())
 *   @Provides(DbConnection)
 *   connection(): DbConnection {
 *     return new DbConnection()
 *   }
 * }
 * ```
 */
export function OnPreDestroy<T>(fn: (instance: T) => void | unknown | Promise<void | unknown>) {
  return function (_target: Function, context: DecoratorContext) {
    if (context.kind !== 'method') {
      throw new ErrInvalidDecorator(`@OnPreDestroy can only be used on a method inside a @${Configuration.name} class`)
    }

    extendMemberInjectableAttributes(context.metadata, context.name, config =>
      config.preDestroy(fn as (value: unknown) => void | Promise<void>),
    )
  }
}
