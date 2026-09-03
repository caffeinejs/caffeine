import { ErrInvalidDecorator } from '../errors.js'
import { Injection, InjectionsFor } from '../injection.js'
import { isNil } from '../internal/util/assert/index.js'
import { InjectionToken, NamedToken, isNamedKey } from '../key.js'
import { Configuration } from './configuration.js'
import { extendMemberInjectableAttributes } from './registrar/index.js'
import { normalizeInjections } from './util/index.js'

/**
 * Marks a method inside a `@Configuration` class as a factory that provides a binding.
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
export function Provides<R>(
  key: InjectionToken<R>,
): (target: () => R | Promise<R>, context: ClassMethodDecoratorContext) => void
export function Provides<R, A extends unknown[]>(
  key: InjectionToken<R>,
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => R | Promise<R>, context: ClassMethodDecoratorContext) => void
export function Provides<R>(
  key: InjectionToken<R>,
  name: NamedToken<R>,
): (target: () => R | Promise<R>, context: ClassMethodDecoratorContext) => void
export function Provides<R, A extends unknown[]>(
  key: InjectionToken<R>,
  name: NamedToken<R>,
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => R | Promise<R>, context: ClassMethodDecoratorContext) => void
export function Provides(
  key: InjectionToken<any>,
  nameOrDependencies?: Injection[] | NamedToken<any>,
  dependencies?: Injection[],
) {
  return function (target: Function, context: DecoratorContext) {
    if (context.kind === 'class') {
      throw new ErrInvalidDecorator(
        `Cannot use @${Provides.name} on a class "${context.name}": use it on a method inside a @${Configuration.name} class`,
      )
    }

    const deps = Array.isArray(nameOrDependencies) ? (nameOrDependencies as Injection[]) : (dependencies ?? [])
    const name = isNil(nameOrDependencies)
      ? undefined
      : isNamedKey(nameOrDependencies)
        ? (nameOrDependencies as InjectionToken)
        : undefined

    if (isNil(key)) {
      throw new ErrInvalidDecorator(
        `@${Provides.name} on a @${Configuration.name} method must receive a valid key: received "${String(key)}" on method "${String(context.name)}" of class "${target.constructor.name}"`,
      )
    }

    const type = typeof key === 'function' ? key : undefined
    const actualKey = typeof name === 'undefined' ? key : name

    extendMemberInjectableAttributes(context.metadata, context.name, config =>
      config.dependencies(normalizeInjections(deps)).key(actualKey).type(type),
    )
  }
}
