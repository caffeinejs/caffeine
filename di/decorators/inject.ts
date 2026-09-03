import { DeferredCtor } from '../deferred_ctor.js'
import { ErrInvalidDecorator } from '../errors.js'
import { Injection, InjectionDescriptor, InjectionsFor, ResolveInjection } from '../injection.js'
import { notNil } from '../internal/util/assert/index.js'
import { InjectionToken } from '../key.js'
import { defineMemberInjection } from './registrar/index.js'

/**
 * Injects a dependency into a field, getter, setter, accessor, or method.
 *
 * On methods, pass an `Injection[]` matching parameter order.
 * On fields/getters/setters, pass a key or `InjectionDescriptor`.
 *
 * @param key - Injection token: class reference, named token, or `InjectionDescriptor`.
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
/** A member whose value the container supplies: field, accessor, getter or setter. */
type InjectedMemberContext<T> =
  | ClassFieldDecoratorContext<unknown, T>
  | ClassAccessorDecoratorContext<unknown, T>
  | ClassGetterDecoratorContext<unknown, T>
  | ClassSetterDecoratorContext<unknown, T>

export function Inject<T>(
  key: InjectionToken<T>,
): (target: Function | object | undefined, context: InjectedMemberContext<T>) => void
export function Inject<D extends InjectionDescriptor<any>>(
  descriptor: D,
): (target: Function | object | undefined, context: InjectedMemberContext<ResolveInjection<D>>) => void
export function Inject<A extends unknown[]>(
  dependencies: [...InjectionsFor<A>],
): (target: (...args: A) => unknown, context: ClassMethodDecoratorContext) => void
export function Inject(
  keyOrDependencies: InjectionToken | InjectionDescriptor | Injection[],
): (target: Function | object | undefined, context: ClassMemberDecoratorContext) => void {
  notNil(keyOrDependencies, `@${Inject.name} parameter key or dependencies is required.`)

  return function (_target: Function | object | undefined, context: ClassMemberDecoratorContext) {
    switch (context.kind) {
      case 'method': {
        if (!Array.isArray(keyOrDependencies)) {
          throw new ErrInvalidDecorator(
            `When using the @${Inject.name} decorator on a method, parameter dependencies must be an array.\n` +
              `Received: ${typeof keyOrDependencies}\n` +
              `Check method ${String(context.name)}.`,
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
          defineMemberInjection(context, context.name, context.kind, { key: keyOrDependencies as InjectionToken })
        }

        break
    }
  }
}
