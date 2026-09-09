import { ErrInvalidDecorator } from '../errors.js'
import { Configuration } from './configuration.js'
import { extendMemberInjectableAttributes } from './registrar/index.js'

/** The callbacks {@link OnLifecycle} configures for a bean produced by a `@Provides` method. */
export interface OnLifecycleOptions<T> {
  /** Called during `init()` with the produced instance, after every binding has been resolved. */
  bootstrap?: (instance: T) => void | unknown | Promise<void | unknown>
  /** Called with the produced instance before the container is disposed. */
  destroy?: (instance: T) => void | unknown | Promise<void | unknown>
}

/**
 * Configures bootstrap and pre-destroy callbacks for a bean produced by a `@Provides` method. Each callback
 * receives the produced instance and may be asynchronous.
 *
 * @example
 * ```ts
 * @Configuration()
 * class AppConfig {
 *   @OnLifecycle<DbConnection>({ bootstrap: c => c.open(), destroy: c => c.close() })
 *   @Provides(DbConnection)
 *   connection(): DbConnection {
 *     return new DbConnection()
 *   }
 * }
 * ```
 */
export function OnLifecycle<T>(options: OnLifecycleOptions<T>) {
  return function (_target: Function, context: DecoratorContext) {
    if (context.kind !== 'method') {
      throw new ErrInvalidDecorator(`@OnLifecycle can only be used on a method inside a @${Configuration.name} class`)
    }

    extendMemberInjectableAttributes(context.metadata, context.name, config => {
      if (options.bootstrap !== undefined) {
        config.bootstrap(options.bootstrap as (value: unknown) => void | Promise<void>)
      }
      if (options.destroy !== undefined) {
        config.preDestroy(options.destroy as (value: unknown) => void | Promise<void>)
      }
    })
  }
}
