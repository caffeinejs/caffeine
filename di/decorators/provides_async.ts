import { Injection, InjectionsFor } from '../injection.js'
import { InjectionToken, NamedToken } from '../key.js'
import { defineProvides } from './_provides.js'

/**
 * Marks a method inside a `@Configuration` class as an asynchronous factory that provides a binding.
 *
 * The container awaits the promise while it initializes and caches what it resolved to, so a dependant is
 * injected the value and never the promise. Async bindings are resolved before anything else, in dependency
 * order, which is why the factory is declared here rather than inferred from what it happens to return.
 *
 * @param key - The binding key to register.
 * @param dependencies - One injection per method parameter, in order.
 *
 * @example
 * ```ts
 * @Configuration()
 * class DatabaseConfig {
 *   @ProvidesAsync(DataSource)
 *   async dataSource(): Promise<DataSource> {
 *     return new DataSource(options).initialize()
 *   }
 * }
 * ```
 */
export function ProvidesAsync<R>(
  key: InjectionToken<R>,
): (target: () => Promise<R>, context: ClassMethodDecoratorContext) => void
export function ProvidesAsync<R, A extends unknown[]>(
  key: InjectionToken<R>,
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => Promise<R>, context: ClassMethodDecoratorContext) => void
export function ProvidesAsync<R>(
  key: InjectionToken<R>,
  name: NamedToken<R>,
): (target: () => Promise<R>, context: ClassMethodDecoratorContext) => void
export function ProvidesAsync<R, A extends unknown[]>(
  key: InjectionToken<R>,
  name: NamedToken<R>,
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => Promise<R>, context: ClassMethodDecoratorContext) => void
export function ProvidesAsync(
  key: InjectionToken<any>,
  nameOrDependencies?: Injection[] | NamedToken<any>,
  dependencies?: Injection[],
) {
  return defineProvides(ProvidesAsync.name, true, key, nameOrDependencies, dependencies)
}
