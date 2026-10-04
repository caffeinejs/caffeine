import { type Annotation, reflect } from './reflect.js'

type Decorator = (target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => void

type Annotator<C, M> = ((value: C | M) => Decorator) & Annotation<C, M>

/**
 * Creates a decorator factory applicable to both classes and class members.
 * When applied to a class, stores the value in the class slot; when applied to
 * a method, field, or accessor, stores it in the member slot keyed by name.
 *
 * Use two type parameters to express different shapes per target:
 * `C` for class-level, `M` for member-level (defaults to `C`).
 *
 * @example
 * ```ts
 * const Route = createAnnotation<{ prefix: string }, { path: string }>()
 *
 * @Route({ prefix: '/api' })
 * class Controller {
 *   @Route({ path: '/users' })
 *   list() {}
 * }
 *
 * reflect.get(Controller, Route)            // { prefix: '/api' }
 * reflect.get(Controller, Route, 'list')    // { path: '/users' }
 * ```
 *
 * Pass a transform to control the decorator call signature:
 *
 * ```ts
 * const Roles = createAnnotation((...roles: string[]) => roles)
 *
 * @Roles('admin', 'user')
 * class AdminCtrl {}
 *
 * reflect.get(AdminCtrl, Roles)  // ['admin', 'user']
 * ```
 */
export function createAnnotation<C, M = C>(): Annotator<C, M>
export function createAnnotation<Args extends unknown[], T>(
  transform: (...args: Args) => T,
): ((...args: Args) => Decorator) & Annotation<T, T>
export function createAnnotation(transform?: (...args: unknown[]) => unknown): unknown {
  const factory: ((...args: unknown[]) => Decorator) & Annotation = (...args: unknown[]) => {
    const value = transform ? transform(...args) : args[0]
    return (_: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
      reflect.annotate(context, factory, value)
    }
  }

  return factory
}
