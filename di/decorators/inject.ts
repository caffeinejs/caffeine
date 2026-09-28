import { DeferredCtor } from '../deferred_ctor.js'
import { ErrInvalidDecorator } from '../errors.js'
import { InjectionDescriptor, ResolveInjection } from '../injection.js'
import { notNil } from '../internal/util/assert/index.js'
import { InjectionToken } from '../key.js'
import { defineMemberInjection } from './registrar/index.js'

/**
 * Injects a dependency into a field, getter, setter, or accessor.
 *
 * Methods are not injection points.
 *
 * @throws {@link ErrInvalidDecorator} when applied to a method.
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
export function Inject(
  key: InjectionToken | InjectionDescriptor,
): (target: Function | object | undefined, context: ClassMemberDecoratorContext) => void {
  notNil(key, `@${Inject.name} parameter key is required.`)

  return function (_target: Function | object | undefined, context: ClassMemberDecoratorContext) {
    switch (context.kind) {
      case 'method':
        throw new ErrInvalidDecorator(
          `Cannot use @${Inject.name} on method "${String(context.name)}": method injection is not supported`,
        )

      case 'accessor':
      case 'field':
      case 'getter':
      case 'setter':
        if (typeof key === 'object' && !(key instanceof DeferredCtor)) {
          defineMemberInjection(context, context.name, context.kind, key)
        } else {
          defineMemberInjection(context, context.name, context.kind, { key: key as InjectionToken })
        }

        break
    }
  }
}
