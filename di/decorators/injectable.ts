import { ErrInvalidDecorator } from '../errors.js'
import { Injection } from '../injection.js'
import { isNamedKey, NamedToken, InjectionToken } from '../key.js'
import { AbstractCtor, Ctor } from '../types.js'
import { Extends } from './extends.js'
import { defineInjectable } from './registrar/index.js'

/**
 * Marks a class as an injectable component, registering it in the container.
 *
 * Pass a named token (`token<T>(...)`) to bind by name instead of type.
 * For abstract-type binding use `@Extends` instead.
 *
 * @param key - Optional named token.
 * @param dependencies - Optional constructor injections.
 *
 * @example
 * ```ts
 * @Injectable()
 * class UserService {}
 *
 * const kUserService = token<UserService>('userService')
 *
 * @Injectable(kUserService)
 * class UserService {}
 * ```
 */
export function Injectable(): (target: Ctor, context: ClassDecoratorContext) => void
export function Injectable(key: NamedToken<any>): (target: Ctor, context: ClassDecoratorContext) => void
export function Injectable(dependencies: Injection[]): (target: Ctor, context: ClassDecoratorContext) => void
export function Injectable(
  key: NamedToken<any>,
  dependencies: Injection[],
): (target: Ctor, context: ClassDecoratorContext) => void
export function Injectable<T>(keyOrDependencies?: InjectionToken | Injection[], dependencies?: Injection[]) {
  const key = keyOrDependencies !== undefined && !Array.isArray(keyOrDependencies) ? keyOrDependencies : undefined
  const deps = Array.isArray(keyOrDependencies) ? keyOrDependencies : (dependencies ?? [])

  if (key !== undefined && !isNamedKey(key)) {
    throw new ErrInvalidDecorator(
      `@${Injectable.name} only accepts a string or symbol as a named key: received "${typeof key}" on the decorated class.\n` +
        `To bind this to an abstract class, decorate this class with @${Extends.name}()`,
    )
  }

  return (target: Ctor, context: ClassDecoratorContext) => {
    const parent = Object.getPrototypeOf(target) as Ctor | AbstractCtor
    defineInjectable<T>(context.metadata, target, config => {
      config.type(target).dependencies(deps).names(key)
      if (parent !== Function.prototype) {
        config.extend(parent)
      }
    })
  }
}
