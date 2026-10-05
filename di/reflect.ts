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
  statics?: Map<string | symbol, unknown>
}

type Store = Map<MetadataKey, Entry>

interface MemberOptions {
  /** Addresses the static member of that name instead of the instance member. */
  readonly static?: boolean
}

function slotOf(entry: Entry | undefined, member: PropertyKey | undefined, isStatic: boolean): unknown {
  if (entry === undefined) {
    return undefined
  }

  if (member === undefined) {
    return entry.class
  }

  return (isStatic ? entry.statics : entry.members)?.get(member as string | symbol)
}

function writeMember(entry: Entry, member: string | symbol, isStatic: boolean, value: unknown): void {
  const slots = isStatic ? (entry.statics ??= new Map()) : (entry.members ??= new Map())
  slots.set(member, value)
}

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

function entryIn(metadata: DecoratorMetadata | null | undefined, key: MetadataKey): Entry | undefined {
  if (metadata == null || !Object.hasOwn(metadata, Keys.kMetadata)) {
    return undefined
  }

  return (metadata[Keys.kMetadata] as Store).get(key)
}

function ownEntry(cls: AnyClass, key: MetadataKey): Entry | undefined {
  return Object.hasOwn(cls, Symbol.metadata) ? entryIn(cls[Symbol.metadata], key) : undefined
}

// Every decorator context, of every kind and under every emitter in use, carries these three.
function isContext(target: object): target is AnyContext {
  const candidate = target as { kind?: unknown; addInitializer?: unknown }
  return (
    typeof target === 'object' &&
    typeof candidate.kind === 'string' &&
    'metadata' in target &&
    typeof candidate.addInitializer === 'function'
  )
}

function chainOf(cls: AnyClass): AnyClass[] {
  const chain: AnyClass[] = []
  for (let c: AnyClass | null = cls; c !== null && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    chain.push(c)
  }

  return chain
}

function read(target: AnyClass | AnyContext, key: MetadataKey, member: PropertyKey | undefined, isStatic: boolean) {
  if (isContext(target)) {
    return slotOf(entryIn(target.metadata, key), member, isStatic)
  }

  return nearest(target, key, member, isStatic)
}

function nearest(cls: AnyClass, key: MetadataKey, member: PropertyKey | undefined, isStatic = false): unknown {
  let c: AnyClass | null = cls
  while (c !== null && c !== Function.prototype) {
    const value = slotOf(ownEntry(c, key), member, isStatic)
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
 * metadata of its base class. A static member's value is kept apart from an instance member's of
 * the same name. The value is checked against the annotation's value type, and a key created with
 * `createAnnotation.on(...)` is refused outside its targets with `ErrInvalidDecorator`.
 * @param memberName - Writes that member's slot regardless of the decorator kind
 * @param options - With `memberName`, `{ static: true }` writes the static member's slot
 */
function annotate<X extends AnyContext, V = unknown, N extends string | symbol | undefined = undefined>(
  context: X,
  key: symbol | ([N] extends [undefined] ? Annotation<V, TargetOf<X>> : OnMember<V>),
  value: NoInfer<V>,
  memberName?: N,
  options?: MemberOptions,
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
    writeMember(entry, memberName, options?.static === true, value)
  } else if (context.kind === 'class') {
    entry.class = value
  } else {
    writeMember(entry, context.name, context.static, value)
  }
}

/**
 * Returns the class slot stored under a symbol key, or `undefined` if absent.
 *
 * With `member`, returns that member's slot only; it does not fall back to the class slot. Use
 * {@link effective} for member-then-class. `{ static: true }` reads the static member of that name.
 *
 * `target` is a class, whose constructor chain is read, or the context a decorator receives, which
 * reads only what the decorators of the class being defined have written so far.
 */
function get<T>(target: AnyClass | AnyContext, key: symbol): T | undefined
function get<T>(target: AnyClass | AnyContext, key: symbol, member: PropertyKey, options?: MemberOptions): T | undefined
/**
 * Returns the class-level value of an annotation that applies to classes, or `undefined` if absent.
 *
 * With `member`, returns that member's value only, for an annotation that applies to members; it
 * does not fall back to the class value. Use {@link effective} for member-then-class. `member`
 * autocompletes to the declared members of a class, and `{ static: true }` reads the static member
 * of that name.
 *
 * `target` is a class, whose constructor chain is read, or the context a decorator receives, which
 * reads only what the decorators of the class being defined have written so far. Inside a class
 * decorator that includes every member decorator and every class decorator written below it.
 */
function get<V>(target: AnyClass | AnyContext, key: OnClass<V>): V | undefined
function get<TClass extends AnyClass, V>(
  target: TClass | AnyContext,
  key: OnMember<V>,
  member: ClassMember<TClass>,
  options?: MemberOptions,
): V | undefined
function get(target: AnyClass | AnyContext, key: MetadataKey, member?: PropertyKey, options?: MemberOptions): unknown {
  return read(target, key, member, options?.static === true)
}

/**
 * Lists the members that carry `key`, by member name.
 *
 * On a class, members declared on base classes are included and the nearest declaration of a name
 * wins. On the context a decorator receives, only what the decorators of the class being defined
 * have written so far is listed. Members whose value is `undefined` are left out, and no order is
 * promised. `{ static: true }` lists static members instead of instance members.
 */
function members<T>(target: AnyClass | AnyContext, key: symbol, options?: MemberOptions): Map<string | symbol, T>
function members<V>(target: AnyClass | AnyContext, key: OnMember<V>, options?: MemberOptions): Map<string | symbol, V>
function members(
  target: AnyClass | AnyContext,
  key: MetadataKey,
  options?: MemberOptions,
): Map<string | symbol, unknown> {
  const isStatic = options?.static === true
  const entries = isContext(target) ? [entryIn(target.metadata, key)] : chainOf(target).map(c => ownEntry(c, key))
  const result = new Map<string | symbol, unknown>()

  for (const entry of entries) {
    for (const [name, value] of (isStatic ? entry?.statics : entry?.members) ?? []) {
      if (value !== undefined && !result.has(name)) {
        result.set(name, value)
      }
    }
  }

  return result
}

/**
 * Returns the value in effect for `member`: its member slot if any class in the chain declares
 * one, otherwise the nearest class slot.
 *
 * A member slot declared on a base class beats the class slot of the subclass. The class slot
 * applies to static members too: `{ static: true }` reads the static member of that name first.
 *
 * @example
 * ```ts
 * reflect.effective(AdminCtrl, Roles, 'delete') // ['superadmin']
 * reflect.effective(AdminCtrl, Roles, 'list')   // ['admin']  — falls back to class
 * ```
 */
function effective<T>(cls: AnyClass, key: symbol, member: PropertyKey, options?: MemberOptions): T | undefined
function effective<TClass extends AnyClass, V>(
  cls: TClass,
  key: Annotation<V, never>,
  member: ClassMember<TClass>,
  options?: MemberOptions,
): V | undefined
function effective(cls: AnyClass, key: MetadataKey, member: PropertyKey, options?: MemberOptions): unknown {
  const own = nearest(cls, key, member, options?.static === true)
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
function merge<T>(cls: AnyClass, key: symbol, member: PropertyKey, options?: MemberOptions): T[]
function merge<TClass extends AnyClass, T>(
  cls: TClass,
  key: Annotation<T[], never>,
  member: ClassMember<TClass>,
  options?: MemberOptions,
): T[]
function merge(cls: AnyClass, key: MetadataKey, member: PropertyKey, options?: MemberOptions): unknown[] {
  const classValue = nearest(cls, key, undefined) as unknown[] | undefined
  const memberValue = nearest(cls, key, member, options?.static === true) as unknown[] | undefined

  return [...(classValue ?? []), ...(memberValue ?? [])]
}

/**
 * Reads and writes decorator metadata by key.
 *
 * A key is a symbol or an {@link Annotation}. Every class owns its store: a decorator on a subclass
 * never writes into its base class's metadata. Reads walk the constructor chain from `cls` upwards
 * and the nearest class declaring the slot wins, so an undecorated subclass reads its base's values,
 * a decorated subclass shadows them, and a method override without its own annotation still carries
 * the base method's value. A slot holding `undefined` counts as absent. A static member and an
 * instance member with the same name keep separate slots; `{ static: true }` addresses the static
 * one. Inside a decorator, `get` and `members` also take its context, to read what the class being
 * defined carries so far.
 */
export const reflect = {
  annotate,
  get,
  effective,
  merge,
  members,
}
