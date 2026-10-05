import { ErrInvalidDecorator } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
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

interface Repeatable {
  /** Collects every application's value, in source order, instead of refusing a second one. */
  readonly repeatable: true
}

interface Single {
  readonly repeatable?: false
}

interface AnnotationFactory<K extends AnnotationTarget> {
  <V = void>(options: Repeatable): Annotator<Args<V>, Stored<V>[], K>
  <V = void>(options?: Single): Annotator<Args<V>, Stored<V>, K>
  <A extends unknown[], V>(transform: (...args: A) => V, options: Repeatable): Annotator<A, V[], K>
  <A extends unknown[], V>(transform: (...args: A) => V, options?: Single): Annotator<A, V, K>
}

type Transform = (...args: unknown[]) => unknown

interface FactoryOptions {
  readonly repeatable?: boolean
}

function build(
  targets: readonly AnnotationTarget[] | undefined,
  first?: Transform | FactoryOptions,
  second?: FactoryOptions,
): unknown {
  const transform = typeof first === 'function' ? first : undefined
  const repeatable = (typeof first === 'function' ? second : first)?.repeatable === true

  const factory: ((...args: unknown[]) => DecoratorOn<AnnotationTarget>) & Annotation<unknown, AnnotationTarget> = (
    ...args
  ) => {
    const value = transform === undefined ? (args.length === 0 ? true : args[0]) : transform(...args)

    return (_target, context) => {
      const previous =
        context.kind === 'class'
          ? reflect.get(context, factory)
          : reflect.get(context, factory, context.name, { static: context.static })

      if (repeatable) {
        // Decorators apply innermost first: prepending keeps the order they are written in.
        reflect.annotate(context, factory, [value, ...((previous as unknown[] | undefined) ?? [])])
        return
      }

      if (previous !== undefined) {
        throw new ErrInvalidDecorator(
          `Cannot apply an annotation twice to ${context.kind} "${String(context.name)}"` +
            solutions('Create the annotation with { repeatable: true } to collect every value'),
        )
      }

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
  return ((first?: Transform | FactoryOptions, second?: FactoryOptions) =>
    build(targets, first, second)) as AnnotationFactory<T[number]>
}

/**
 * Creates an annotation: a decorator factory whose value {@link reflect} reads back, keyed by the
 * factory itself.
 *
 * `createAnnotation<V>()` applies to classes and to every kind of member, and
 * `createAnnotation.on(...targets)` restricts it. Without a value type the annotation is a marker:
 * `@Deprecated()` takes no argument and stores `true`. A transform turns the decorator's arguments
 * into the stored value. Applying an annotation twice to one target throws `ErrInvalidDecorator`;
 * created with `{ repeatable: true }`, it collects every application's value in source order
 * instead. For a rule the targets cannot express, such as async methods only, write the decorator
 * by hand: see {@link Annotation}.
 *
 * @example
 * ```ts
 * const Entity = createAnnotation.on('class')<{ table: string }>()
 * const Route = createAnnotation.on('method')((path: string) => ({ path }))
 * const Tags = createAnnotation<string>({ repeatable: true })
 * const Deprecated = createAnnotation()
 *
 * @Entity({ table: 'users' })
 * @Tags('public')
 * @Tags('v2')
 * class Users {
 *   @Route('/users')
 *   @Deprecated()
 *   list() {}
 * }
 *
 * reflect.get(Users, Entity)             // { table: 'users' }
 * reflect.get(Users, Tags)               // ['public', 'v2']
 * reflect.get(Users, Route, 'list')      // { path: '/users' }
 * reflect.get(Users, Deprecated, 'list') // true
 * ```
 */
export const createAnnotation = Object.assign(
  (first?: Transform | FactoryOptions, second?: FactoryOptions) => build(undefined, first, second),
  { on },
) as AnnotationFactory<AnnotationTarget> & { readonly on: typeof on }
