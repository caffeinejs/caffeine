import {
  type Annotation,
  type AnnotationOptions,
  type AnnotationTarget,
  kAnnotationOptions,
  reflect,
} from './reflect.js'
import type { AnyClass } from './types.js'

interface Targets {
  class: [target: AnyClass, context: ClassDecoratorContext]
  method: [target: Function, context: ClassMethodDecoratorContext]
  field: [target: undefined, context: ClassFieldDecoratorContext]
  accessor: [target: ClassAccessorDecoratorTarget<unknown, unknown>, context: ClassAccessorDecoratorContext]
  getter: [target: Function, context: ClassGetterDecoratorContext]
  setter: [target: Function, context: ClassSetterDecoratorContext]
}

type DecoratorOn<K extends AnnotationTarget> = (target: Targets[K][0], context: Targets[K][1]) => void

// `void` makes a marker; `any` does not.
type IsMarker<V> = 0 extends 1 & V ? false : [V] extends [void] ? true : false

type Args<V> = IsMarker<V> extends true ? [] : [value: V]

type Stored<V> = IsMarker<V> extends true ? true : V

type Annotator<A extends unknown[], S, K extends AnnotationTarget> = ((...args: A) => DecoratorOn<K>) & Annotation<S, K>

interface AnnotationFactory<K extends AnnotationTarget> {
  <V = void>(): Annotator<Args<V>, Stored<V>, K>
  <A extends unknown[], V>(transform: (...args: A) => V): Annotator<A, V, K>
}

type Transform = (...args: unknown[]) => unknown

function build(targets: readonly AnnotationTarget[] | undefined, transform: Transform | undefined): unknown {
  const factory: ((...args: unknown[]) => DecoratorOn<AnnotationTarget>) & Annotation<unknown, AnnotationTarget> = (
    ...args
  ) => {
    const value = transform === undefined ? (args.length === 0 ? true : args[0]) : transform(...args)
    return (_target, context) => {
      reflect.annotate(context, factory, value)
    }
  }

  const options: AnnotationOptions = { targets }
  Object.defineProperty(factory, kAnnotationOptions, { value: Object.freeze(options) })

  return factory
}

/**
 * Creates an annotation that applies only to `targets`.
 *
 * Applying it anywhere else is a type error. From plain JavaScript or through a cast it throws
 * `ErrInvalidDecorator` when the class is defined.
 */
function on<const T extends readonly [AnnotationTarget, ...AnnotationTarget[]]>(
  ...targets: T
): AnnotationFactory<T[number]> {
  return ((transform?: Transform) => build(targets, transform)) as AnnotationFactory<T[number]>
}

/**
 * Creates an annotation: a decorator factory whose value {@link reflect} reads back, keyed by the
 * factory itself.
 *
 * `createAnnotation<V>()` applies to classes and to every kind of member, and
 * `createAnnotation.on(...targets)` restricts it. Without a value type the annotation is a marker:
 * `@Deprecated()` takes no argument and stores `true`. A transform turns the decorator's arguments
 * into the stored value. For a rule the targets cannot express, such as async methods only, write
 * the decorator by hand: see {@link Annotation}.
 *
 * @example
 * ```ts
 * const Entity = createAnnotation.on('class')<{ table: string }>()
 * const Route = createAnnotation.on('method')((path: string) => ({ path }))
 * const Deprecated = createAnnotation()
 *
 * @Entity({ table: 'users' })
 * class Users {
 *   @Route('/users')
 *   @Deprecated()
 *   list() {}
 * }
 *
 * reflect.get(Users, Entity)             // { table: 'users' }
 * reflect.get(Users, Route, 'list')      // { path: '/users' }
 * reflect.get(Users, Deprecated, 'list') // true
 * ```
 */
export const createAnnotation = Object.assign((transform?: Transform) => build(undefined, transform), {
  on,
}) as AnnotationFactory<AnnotationTarget> & { readonly on: typeof on }
