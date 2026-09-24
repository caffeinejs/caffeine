import { Injection, InjectionsFor } from '../injection.js'
import { InjectionToken, NamedToken } from '../key.js'
import { defineProvides } from './_provides.js'

/**
 * Marks a method inside a `@Configuration` class as a factory that provides a binding.
 *
 * The factory is synchronous: a method returning a promise does not compile here, because the container
 * would cache the promise itself and every dependant would receive it unresolved. Declare such a factory
 * with `@ProvidesAsync`, which awaits it before anything is injected.
 *
 * @param key - The binding key to register.
 * @param dependencies - One injection per method parameter, in order.
 *
 * @example
 * ```ts
 * @Configuration()
 * class AppConfig {
 *   @Provides(HTTPClient)
 *   httpClient(): HTTPClient {
 *     return new HTTPClient({ timeout: 5000 })
 *   }
 * }
 * ```
 */
export function Provides<R>(key: InjectionToken<R>): (target: () => R, context: ClassMethodDecoratorContext) => void
export function Provides<R, A extends unknown[]>(
  key: InjectionToken<R>,
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => R, context: ClassMethodDecoratorContext) => void
export function Provides<R>(
  key: InjectionToken<R>,
  name: NamedToken<R>,
): (target: () => R, context: ClassMethodDecoratorContext) => void
export function Provides<R, A extends unknown[]>(
  key: InjectionToken<R>,
  name: NamedToken<R>,
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => R, context: ClassMethodDecoratorContext) => void
export function Provides(
  key: InjectionToken<any>,
  nameOrDependencies?: Injection[] | NamedToken<any>,
  dependencies?: Injection[],
) {
  return defineProvides(Provides.name, false, key, nameOrDependencies, dependencies)
}
