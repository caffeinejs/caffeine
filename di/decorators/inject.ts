import { ErrInvalidDecorator } from '../errors.js'
import { notNil } from '../internal/util/assert/index.js'
import { DeferredCtor } from '../deferred_ctor.js'
import { Key } from '../key.js'
import { Injection, InjectionDescriptor } from '../injection.js'
import { defineMemberInjection } from './registrar/index.js'

/**
 * Injects a dependency into a field, getter, setter, accessor, or method.
 *
 * On methods, pass an `Injection[]` matching parameter order.
 * On fields/getters/setters, pass a key or `InjectionDescriptor`.
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
 */
export function Inject(key: Key): (target: Function | object | undefined, context: ClassMemberDecoratorContext) => void
export function Inject(
  descriptor: InjectionDescriptor,
): (target: Function | object | undefined, context: ClassMemberDecoratorContext) => void
export function Inject(
  dependencies: Injection[],
): (target: Function | object | undefined, context: ClassMemberDecoratorContext) => void
export function Inject(
  keyOrDependencies: Key | InjectionDescriptor | Injection[],
): (target: Function | object | undefined, context: ClassMemberDecoratorContext) => void {
  notNil(keyOrDependencies, `@${Inject.name} parameter key or dependencies is required.`)

  return function (_target: Function | object | undefined, context: ClassMemberDecoratorContext) {
    switch (context.kind) {
      case 'method': {
        if (!Array.isArray(keyOrDependencies)) {
          throw new ErrInvalidDecorator(
            `When using the @${Inject.name} decorator on a method, parameter dependencies must be an array.\n`
            + `Received: ${typeof keyOrDependencies}\n`
            + `Check method ${String(context.name)}.`,
          )
        }

        defineMemberInjection(context, context.name, 'method', keyOrDependencies)

        break
      }

      case 'accessor':
      case 'field':
      case 'getter':
      case 'setter':
        if (typeof keyOrDependencies === 'object' && !(keyOrDependencies instanceof DeferredCtor)) {
          defineMemberInjection(context, context.name, context.kind, keyOrDependencies)
        } else {
          defineMemberInjection(context, context.name, context.kind, { key: keyOrDependencies as Key })
        }

        break
    }
  }
}
