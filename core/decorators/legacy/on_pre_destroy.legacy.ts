import { ErrInvalidDecorator } from '../../errors.js'
import { extendMemberInjectableAttributes } from '../registrar/index.js'
import { idfy } from '../registrar/types.js'
import { Configuration } from './configuration.legacy.js'

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
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function OnPreDestroy<T>(fn: (instance: T) => void | unknown | Promise<void | unknown>) {
  return function (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) {
    if (typeof propertyKey === 'undefined') {
      throw new ErrInvalidDecorator(
        `@OnPreDestroy can only be used on a method inside a @${Configuration.name} class`,
      )
    }

    extendMemberInjectableAttributes(idfy(target), propertyKey,
      config =>
        config.preDestroy(fn as (value: unknown) => void | Promise<void>))
  }
}
