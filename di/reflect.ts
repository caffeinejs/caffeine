import { ErrInvalidDecorator } from './errors.js'
import { Keys } from './symbols.js'
import type { AnyClass, ClassMember } from './types.js'

/**
 * Where an annotation applies: the class itself or one kind of class member.
 */
export type AnnotationTarget = 'class' | 'method' | 'field' | 'accessor' | 'getter' | 'setter'

declare const annotationTypes: unique symbol

/**
 * A typed key for {@link reflect}: `V` is the value it stores and `K` the targets it applies to.
 *
 * `createAnnotation` returns one. A decorator written by hand becomes its own key by declaring its
 * type as an intersection with `Annotation`, so one object both writes and reads:
 *
 * @example
 * ```ts
 * type AsyncMethod = (...args: any[]) => Promise<unknown>
 *
 * const Retry: ((attempts: number) => (target: AsyncMethod, context: ClassMethodDecoratorContext<unknown, AsyncMethod>) => void) &
 *   Annotation<number, 'method'> = attempts => (_target, context) => {
 *   reflect.annotate(context, Retry, attempts)
 * }
 *
 * reflect.get(Client, Retry, 'fetch') // number | undefined
 * ```
 */
export interface Annotation<V = unknown, K extends AnnotationTarget = AnnotationTarget> {
  readonly [annotationTypes]?: { readonly value: V; readonly on: (target: K) => void }
}

// What `createAnnotation` stores on an annotation for `reflect` to enforce.
export interface AnnotationOptions {
  readonly targets?: readonly AnnotationTarget[]
}

// Registered, so a second copy of this module reads what a first copy stored.
export const kAnnotationOptions = Symbol.for('@caffeinejs/di:annotation')

type AnyContext = ClassDecoratorContext | ClassMemberDecoratorContext

type MetadataKey = symbol | Annotation<unknown, never>

type TargetOf<X> = X extends ClassDecoratorContext
  ? 'class'
  : X extends ClassMethodDecoratorContext
    ? 'method'
    : X extends ClassFieldDecoratorContext
      ? 'field'
      : X extends ClassAccessorDecoratorContext
        ? 'accessor'
        : X extends ClassGetterDecoratorContext
          ? 'getter'
          : X extends ClassSetterDecoratorContext
            ? 'setter'
            : never

type OnClass<V> = Annotation<V, 'class'>

type OnMember<V> =
  | Annotation<V, 'method'>
  | Annotation<V, 'field'>
  | Annotation<V, 'accessor'>
  | Annotation<V, 'getter'>
  | Annotation<V, 'setter'>

interface Entry {
  class?: unknown
  members?: Map<string | symbol, unknown>
}

type Store = Map<MetadataKey, Entry>

function optionsOf(key: MetadataKey): AnnotationOptions | undefined {
  if (typeof key === 'symbol') {
    return undefined
  }

  return (key as Record<symbol, AnnotationOptions | undefined>)[kAnnotationOptions]
}

function checkTarget(context: AnyContext, key: MetadataKey, memberName: string | symbol | undefined): void {
  const targets = optionsOf(key)?.targets
  if (targets === undefined) {
    return
  }

  if (memberName === undefined) {
    if (!targets.includes(context.kind)) {
      throw new ErrInvalidDecorator(
        `Cannot apply an annotation to ${context.kind} "${String(context.name)}": it only applies to ${targets.join(', ')}`,
      )
    }

    return
  }

  if (!targets.some(target => target !== 'class')) {
    throw new ErrInvalidDecorator(
      `Cannot apply an annotation to member "${String(memberName)}": it only applies to ${targets.join(', ')}`,
    )
  }
}

function ownEntry(cls: AnyClass, key: MetadataKey): Entry | undefined {
  if (!Object.hasOwn(cls, Symbol.metadata)) {
    return undefined
  }

  const metadata = cls[Symbol.metadata]
  if (metadata == null || !Object.hasOwn(metadata, Keys.kMetadata)) {
    return undefined
  }

  return (metadata[Keys.kMetadata] as Store).get(key)
}

function nearest(cls: AnyClass, key: MetadataKey, member: PropertyKey | undefined): unknown {
  let c: AnyClass | null = cls
  while (c !== null && c !== Function.prototype) {
    const entry = ownEntry(c, key)
    const value = member === undefined ? entry?.class : entry?.members?.get(member as string | symbol)
    if (value !== undefined) {
      return value
    }

    c = Object.getPrototypeOf(c) as AnyClass | null
  }

  return undefined
}

/**
 * Writes `value` under `key` into the metadata of the class being decorated.
 *
 * A class decorator writes the class slot; a member decorator writes the slot of the decorated
 * member. The write lands on the decorated class alone: a subclass's decorator never reaches the
 * metadata of its base class. The value is checked against the annotation's value type, and a key
 * created with `createAnnotation.on(...)` is refused outside its targets with `ErrInvalidDecorator`.
 * @param memberName - Writes that member's slot regardless of the decorator kind
 */
function annotate<X extends AnyContext, V = unknown, N extends string | symbol | undefined = undefined>(
  context: X,
  key: symbol | ([N] extends [undefined] ? Annotation<V, TargetOf<X>> : OnMember<V>),
  value: NoInfer<V>,
  memberName?: N,
): void {
  const k = key as MetadataKey
  checkTarget(context, k, memberName)

  const metadata = context.metadata
  if (!Object.hasOwn(metadata, Keys.kMetadata)) {
    metadata[Keys.kMetadata] = new Map()
  }

  const store = metadata[Keys.kMetadata] as Store
  let entry = store.get(k)
  if (!entry) {
    entry = {}
    store.set(k, entry)
  }

  if (memberName !== undefined) {
    ;(entry.members ??= new Map()).set(memberName, value)
  } else if (context.kind === 'class') {
    entry.class = value
  } else {
    ;(entry.members ??= new Map()).set(context.name, value)
  }
}

/**
 * Returns the class slot stored under a symbol key, or `undefined` if absent.
 *
 * With `member`, returns that member's slot only; it does not fall back to the class slot. Use
 * {@link effective} for member-then-class.
 */
function get<T>(cls: AnyClass, key: symbol): T | undefined
function get<T>(cls: AnyClass, key: symbol, member: PropertyKey): T | undefined
/**
 * Returns the class-level value of an annotation that applies to classes, or `undefined` if absent.
 *
 * With `member`, returns that member's value only, for an annotation that applies to members; it
 * does not fall back to the class value. Use {@link effective} for member-then-class. `member`
 * autocompletes to the declared members of `cls`.
 */
function get<V>(cls: AnyClass, key: OnClass<V>): V | undefined
function get<TClass extends AnyClass, V>(cls: TClass, key: OnMember<V>, member: ClassMember<TClass>): V | undefined
function get(cls: AnyClass, key: MetadataKey, member?: PropertyKey): unknown {
  return nearest(cls, key, member)
}

/**
 * Returns the value in effect for `member`: its member slot if any class in the chain declares
 * one, otherwise the nearest class slot.
 *
 * A member slot declared on a base class beats the class slot of the subclass.
 *
 * @example
 * ```ts
 * reflect.effective(AdminCtrl, Roles, 'delete') // ['superadmin']
 * reflect.effective(AdminCtrl, Roles, 'list')   // ['admin']  — falls back to class
 * ```
 */
function effective<T>(cls: AnyClass, key: symbol, member: PropertyKey): T | undefined
function effective<TClass extends AnyClass, V>(
  cls: TClass,
  key: Annotation<V, never>,
  member: ClassMember<TClass>,
): V | undefined
function effective(cls: AnyClass, key: MetadataKey, member: PropertyKey): unknown {
  const own = nearest(cls, key, member)
  return own !== undefined ? own : nearest(cls, key, undefined)
}

/**
 * Concatenates the nearest class-level array and the nearest member-level array, class values
 * first.
 *
 * Arrays declared further up the chain are not accumulated: a subclass's class-level array replaces
 * its base's.
 *
 * @example
 * ```ts
 * reflect.merge(Ctrl, Roles, 'delete') // ['user', 'admin']
 * ```
 */
function merge<T>(cls: AnyClass, key: symbol, member: PropertyKey): T[]
function merge<TClass extends AnyClass, T>(cls: TClass, key: Annotation<T[], never>, member: ClassMember<TClass>): T[]
function merge(cls: AnyClass, key: MetadataKey, member: PropertyKey): unknown[] {
  const classValue = nearest(cls, key, undefined) as unknown[] | undefined
  const memberValue = nearest(cls, key, member) as unknown[] | undefined

  return [...(classValue ?? []), ...(memberValue ?? [])]
}

/**
 * Reads and writes decorator metadata by key.
 *
 * A key is a symbol or an {@link Annotation}. Every class owns its store: a decorator on a subclass
 * never writes into its base class's metadata. Reads walk the constructor chain from `cls` upwards
 * and the nearest class declaring the slot wins, so an undecorated subclass reads its base's values,
 * a decorated subclass shadows them, and a method override without its own annotation still carries
 * the base method's value. A slot holding `undefined` counts as absent.
 */
export const reflect = {
  annotate,
  get,
  effective,
  merge,
}
