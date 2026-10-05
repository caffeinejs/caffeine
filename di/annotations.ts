import { ErrInvalidDecorator } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
import {
  type Annotation,
  type AnnotationOptions,
  type AnnotationTarget,
  isWritten,
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

// An accumulating annotation must say how two values combine.
type Policy<S> =
  | { readonly inherit?: 'nearest' | 'own'; readonly combine?: (outer: S, inner: S) => S }
  | { readonly inherit: 'accumulate'; readonly combine: (outer: S, inner: S) => S }

interface AnnotationFactory<K extends AnnotationTarget> {
  <V = void>(options: Repeatable & Policy<Stored<V>[]>): Annotator<Args<V>, Stored<V>[], K>
  <V = void>(options?: Single & Policy<Stored<V>>): Annotator<Args<V>, Stored<V>, K>
  <A extends unknown[], V>(transform: (...args: A) => V, options: Repeatable & Policy<V[]>): Annotator<A, V[], K>
  <A extends unknown[], V>(transform: (...args: A) => V, options?: Single & Policy<V>): Annotator<A, V, K>
}

type Transform = (...args: unknown[]) => unknown

interface FactoryOptions {
  readonly repeatable?: boolean
  readonly inherit?: 'nearest' | 'own' | 'accumulate'
  readonly combine?: (outer: unknown, inner: unknown) => unknown
}

// What one application stores: the transform's result, otherwise the argument, or `true` for a marker.
function valueFrom(transform: Transform | undefined, args: unknown[]): unknown {
  if (transform !== undefined) {
    return transform(...args)
  }

  return args.length === 0 ? true : args[0]
}

function build(
  targets: readonly AnnotationTarget[] | undefined,
  first?: Transform | FactoryOptions,
  second?: FactoryOptions,
): unknown {
  const transform = typeof first === 'function' ? first : undefined
  const settings = (typeof first === 'function' ? second : first) ?? {}
  const repeatable = settings.repeatable === true

  if (settings.inherit === 'accumulate' && typeof settings.combine !== 'function') {
    throw new ErrInvalidDecorator(
      'Cannot create an annotation that accumulates: it has no combine rule' +
        solutions('Pass combine(outer, inner) together with inherit: "accumulate"'),
    )
  }

  const factory: ((...args: unknown[]) => DecoratorOn<AnnotationTarget>) & Annotation<unknown, AnnotationTarget> = (
    ...args
  ) => {
    const value = valueFrom(transform, args)

    return (_target, context) => {
      if (repeatable) {
        const previous =
          context.kind === 'class'
            ? reflect.get(context, factory)
            : reflect.get(context, factory, context.name, { static: context.static })

        // Decorators apply innermost first: prepending keeps the order they are written in.
        reflect.annotate(context, factory, [value, ...((previous as unknown[] | undefined) ?? [])])
        return
      }

      // A first application may have stored `undefined`, which reads as absent.
      if (isWritten(context, factory)) {
        throw new ErrInvalidDecorator(
          `Cannot apply an annotation twice to ${context.kind} "${String(context.name)}"` +
            solutions('Create the annotation with { repeatable: true } to collect every value'),
        )
      }

      reflect.annotate(context, factory, value)
    }
  }

  const options: AnnotationOptions = { targets, inherit: settings.inherit, combine: settings.combine }
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

interface CreateAnnotation extends AnnotationFactory<AnnotationTarget> {
  readonly on: typeof on
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
 * `inherit` decides how reads treat base classes: `'nearest'`, the default, takes the closest
 * declaration; `'own'` ignores base classes; `'accumulate'` folds every declaration, from the
 * farthest base to the class, with `combine`. `combine(outer, inner)` also joins a class value with
 * a member value in `reflect.effective`; without it the member value wins.
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
) as CreateAnnotation
