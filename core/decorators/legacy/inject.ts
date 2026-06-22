import { ErrInvalidDecorator } from '../../errors.js'
import { DeferredCtor } from '../../deferred_ctor.js'
import { Key } from '../../key.js'
import { Injection, InjectionDescriptor } from '../../injection.js'
import { defineMemberInjection, storeLegacyParameterInjection } from '../registrar/index.js'

/**
 * Injects a dependency into a field, getter, setter, accessor, method, or constructor parameter.
 *
 * On methods, pass an `Injection[]` matching parameter order.
 * On fields/getters/setters, pass a key or `InjectionDescriptor`.
 * On constructor parameters, use as a parameter decorator with the injection key.
 *
 * @param key - Injection key: class reference, string, symbol, or `InjectionDescriptor`.
 *
 * @example
 * ```ts
 * @Injectable()
 * class OrderService {
 *   @Inject(UserService)
 *   private userService!: UserService
 * }
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Inject(
  key: Key,
): (target: Function | object, propertyKey?: string | symbol, descriptorOrIndex?: PropertyDescriptor | number) => void
export function Inject(
  descriptor: InjectionDescriptor,
): (target: Function | object, propertyKey?: string | symbol, descriptorOrIndex?: PropertyDescriptor | number) => void
export function Inject(
  dependencies: Injection[],
): (target: Function | object, propertyKey?: string | symbol, descriptorOrIndex?: PropertyDescriptor | number) => void
export function Inject(
  keyOrDependencies: Key | InjectionDescriptor | Injection[],
): (target: Function | object, propertyKey?: string | symbol, descriptorOrIndex?: PropertyDescriptor | number) => void {
  return function (
    target: Function | object,
    propertyKey?: string | symbol,
    descriptorOrIndex?: PropertyDescriptor | number,
  ) {
    if (typeof descriptorOrIndex === 'number') {
      const paramDescriptor: InjectionDescriptor
        = typeof keyOrDependencies === 'object' && !(keyOrDependencies instanceof DeferredCtor)
          ? (keyOrDependencies as InjectionDescriptor)
          : { key: keyOrDependencies as Key }
      storeLegacyParameterInjection(target as Function, descriptorOrIndex, paramDescriptor)
      return
    }

    if (propertyKey === undefined) {
      throw new ErrInvalidDecorator(`@${Inject.name} requires a property key when used as a member decorator`)
    }

    if (descriptorOrIndex !== undefined && typeof descriptorOrIndex.value === 'function') {
      if (!Array.isArray(keyOrDependencies)) {
        throw new ErrInvalidDecorator(
          `When using the @${Inject.name} decorator on a method, parameter dependencies must be an array.\n`
          + `Received: ${typeof keyOrDependencies}\n`
          + `Check method ${String(propertyKey)}.`,
        )
      }
      defineMemberInjection(target as object, propertyKey, 'method', keyOrDependencies)
    } else {
      const injection
        = typeof keyOrDependencies === 'object' && !(keyOrDependencies instanceof DeferredCtor)
          ? (keyOrDependencies as InjectionDescriptor)
          : { key: keyOrDependencies as Key }
      defineMemberInjection(target as object, propertyKey, 'field', injection)
    }
  }
}
