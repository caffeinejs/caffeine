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
  readonly inherit?: 'nearest' | 'own' | 'accumulate'
  readonly combine?: (outer: unknown, inner: unknown) => unknown
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

// A class autocompletes its member names; any other target takes a name.
type MemberOf<T> = T extends AnyClass ? ClassMember<T> : string | symbol

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

function slotsOf(entry: Entry | undefined, isStatic: boolean): Iterable<[string | symbol, unknown]> {
  return (isStatic ? entry?.statics : entry?.members) ?? []
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

function metadataOf(target: object): DecoratorMetadata | null | undefined {
  if (!Object.hasOwn(target, Symbol.metadata)) {
    return undefined
  }

  return (target as { [Symbol.metadata]?: DecoratorMetadata | null })[Symbol.metadata]
}

function entryIn(metadata: DecoratorMetadata | null | undefined, key: MetadataKey): Entry | undefined {
  if (metadata == null || !Object.hasOwn(metadata, Keys.kMetadata)) {
    return undefined
  }

  return (metadata[Keys.kMetadata] as Store).get(key)
}

function ownEntry(target: object, key: MetadataKey): Entry | undefined {
  return entryIn(metadataOf(target), key)
}

// The entry `key` has in `metadata`, created along with the store when missing.
function entryFor(metadata: DecoratorMetadataObject, key: MetadataKey): Entry {
  if (!Object.hasOwn(metadata, Keys.kMetadata)) {
    metadata[Keys.kMetadata] = new Map()
  }

  const store = metadata[Keys.kMetadata] as Store
  let entry = store.get(key)
  if (!entry) {
    entry = {}
    store.set(key, entry)
  }

  return entry
}

// A class walks its constructors; an object walks its prototypes. Neither reaches the built-ins.
function isLink(link: object | null): link is object {
  return link !== null && link !== Function.prototype && link !== Object.prototype
}

function chainOf(target: object): object[] {
  const chain: object[] = []
  for (let link: object | null = target; isLink(link); link = Object.getPrototypeOf(link) as object | null) {
    chain.push(link)
  }

  return chain
}

function nearest(target: object, key: MetadataKey, member: PropertyKey | undefined, isStatic: boolean): unknown {
  for (let link: object | null = target; isLink(link); link = Object.getPrototypeOf(link) as object | null) {
    const value = slotOf(ownEntry(link, key), member, isStatic)
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

// `values` runs from the target to its farthest base; folding starts at the base.
function fold(values: unknown[], combine: ((outer: unknown, inner: unknown) => unknown) | undefined): unknown {
  if (values.length === 0 || combine === undefined) {
    return values[0]
  }

  return values.reduceRight((outer, inner) => combine(outer, inner))
}

// Reads a target slot or a member slot through the annotation's `inherit` rule.
function resolve(target: object, key: MetadataKey, member: PropertyKey | undefined, isStatic: boolean): unknown {
  const options = optionsOf(key)

  switch (options?.inherit) {
    case 'own':
      return slotOf(ownEntry(target, key), member, isStatic)
    case 'accumulate': {
      const values: unknown[] = []
      for (const link of chainOf(target)) {
        const value = slotOf(ownEntry(link, key), member, isStatic)
        if (value !== undefined) {
          values.push(value)
        }
      }

      return fold(values, options.combine)
    }
    default:
      return nearest(target, key, member, isStatic)
  }
}

function read(target: object, key: MetadataKey, member: PropertyKey | undefined, isStatic: boolean): unknown {
  if (isContext(target)) {
    return slotOf(entryIn(target.metadata, key), member, isStatic)
  }

  return resolve(target, key, member, isStatic)
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

  const entry = entryFor(context.metadata, k)
  if (memberName !== undefined) {
    writeMember(entry, memberName, options?.static === true, value)
  } else if (context.kind === 'class') {
    entry.class = value
  } else {
    writeMember(entry, context.name, context.static, value)
  }
}

/**
 * Writes `value` under `key` outside a decorator: on a class, a function or any extensible object.
 *
 * Without `member` it writes the target's own slot, which reads back like a class-level value; with
 * `member` it writes that member's slot, and `{ static: true }` the static member's. A target with
 * no metadata of its own gets some. The write overwrites what was there and, unlike a decorator, is
 * not checked against the annotation's targets.
 */
function set<T>(target: object, key: symbol, value: T, member?: PropertyKey, options?: MemberOptions): void
function set<V>(target: object, key: OnClass<V>, value: NoInfer<V>): void
function set<V>(
  target: object,
  key: OnMember<V>,
  value: NoInfer<V>,
  member: string | symbol,
  options?: MemberOptions,
): void
function set(target: object, key: MetadataKey, value: unknown, member?: PropertyKey, options?: MemberOptions): void {
  let metadata = metadataOf(target)
  if (metadata == null) {
    metadata = Object.create(null) as DecoratorMetadataObject
    Object.defineProperty(target, Symbol.metadata, {
      value: metadata,
      configurable: true,
      enumerable: true,
      writable: true,
    })
  }

  const entry = entryFor(metadata, key)
  if (member === undefined) {
    entry.class = value
  } else {
    writeMember(entry, member as string | symbol, options?.static === true, value)
  }
}

/**
 * Returns the target slot stored under a symbol key, or `undefined` if absent.
 *
 * With `member`, returns that member's slot only; it does not fall back to the target slot. Use
 * {@link effective} for member-then-class. `{ static: true }` reads the static member of that name.
 *
 * `target` is a class, whose constructor chain is read; the context a decorator receives, which
 * reads only what the decorators of the class being defined have written so far; or any object
 * written with {@link set}, whose prototype chain is read. An instance does not read its class's
 * annotations: pass its constructor.
 */
function get<T>(target: object, key: symbol): T | undefined
function get<T>(target: object, key: symbol, member: PropertyKey, options?: MemberOptions): T | undefined
/**
 * Returns the class-level value of an annotation that applies to classes, or `undefined` if absent.
 *
 * With `member`, returns that member's value only, for an annotation that applies to members; it
 * does not fall back to the class value. Use {@link effective} for member-then-class. `member`
 * autocompletes to the declared members of a class, and `{ static: true }` reads the static member
 * of that name.
 *
 * `target` is a class, whose constructor chain is read; the context a decorator receives, which
 * reads only what the decorators of the class being defined have written so far, including, in a
 * class decorator, every member decorator and every class decorator written below it; or any object
 * written with {@link set}, whose prototype chain is read. An instance does not read its class's
 * annotations: pass its constructor.
 */
function get<V>(target: object, key: OnClass<V>): V | undefined
function get<TTarget extends object, V>(
  target: TTarget,
  key: OnMember<V>,
  member: MemberOf<TTarget>,
  options?: MemberOptions,
): V | undefined
function get(target: object, key: MetadataKey, member?: PropertyKey, options?: MemberOptions): unknown {
  return read(target, key, member, options?.static === true)
}

/**
 * Lists the members that carry `key`, by member name.
 *
 * On a class, members declared on base classes are included and the nearest declaration of a name
 * wins, unless the annotation's `inherit` rule says otherwise. On the context a decorator receives,
 * only what the decorators of the class being defined have written so far is listed. Members whose
 * value is `undefined` are left out, and no order is promised. `{ static: true }` lists static
 * members instead of instance members.
 */
function members<T>(target: object, key: symbol, options?: MemberOptions): Map<string | symbol, T>
function members<V>(target: object, key: OnMember<V>, options?: MemberOptions): Map<string | symbol, V>
function members(target: object, key: MetadataKey, options?: MemberOptions): Map<string | symbol, unknown> {
  const isStatic = options?.static === true
  const context = isContext(target)
  const policy = context ? undefined : optionsOf(key)
  const entries = context
    ? [entryIn(target.metadata, key)]
    : (policy?.inherit === 'own' ? [target] : chainOf(target)).map(link => ownEntry(link, key))

  // Every value of a name, from the nearest declaration to the farthest.
  const valuesByName = new Map<string | symbol, unknown[]>()
  for (const entry of entries) {
    for (const [name, value] of slotsOf(entry, isStatic)) {
      if (value === undefined) {
        continue
      }

      const values = valuesByName.get(name)
      if (values === undefined) {
        valuesByName.set(name, [value])
      } else {
        values.push(value)
      }
    }
  }

  const accumulate = policy?.inherit === 'accumulate'
  const result = new Map<string | symbol, unknown>()
  for (const [name, values] of valuesByName) {
    result.set(name, accumulate ? fold(values, policy?.combine) : values[0])
  }

  return result
}

/**
 * Returns the value in effect for `member`: its member slot if any class in the chain declares
 * one, otherwise the nearest class slot.
 *
 * A member slot declared on a base class beats the class slot of the subclass. The class slot
 * applies to static members too: `{ static: true }` reads the static member of that name first.
 * When both slots hold a value and the annotation was created with a `combine` rule, the result is
 * `combine(classValue, memberValue)`.
 *
 * @example
 * ```ts
 * reflect.effective(AdminCtrl, Roles, 'delete') // ['superadmin']
 * reflect.effective(AdminCtrl, Roles, 'list')   // ['admin']  — falls back to class
 * ```
 */
function effective<T>(target: object, key: symbol, member: PropertyKey, options?: MemberOptions): T | undefined
function effective<TTarget extends object, V>(
  target: TTarget,
  key: Annotation<V, never>,
  member: MemberOf<TTarget>,
  options?: MemberOptions,
): V | undefined
function effective(target: object, key: MetadataKey, member: PropertyKey, options?: MemberOptions): unknown {
  const inner = resolve(target, key, member, options?.static === true)
  const outer = resolve(target, key, undefined, false)
  const combine = optionsOf(key)?.combine

  if (inner !== undefined && outer !== undefined && combine !== undefined) {
    return combine(outer, inner)
  }

  return inner !== undefined ? inner : outer
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
function merge<T>(target: object, key: symbol, member: PropertyKey, options?: MemberOptions): T[]
function merge<TTarget extends object, T>(
  target: TTarget,
  key: Annotation<T[], never>,
  member: MemberOf<TTarget>,
  options?: MemberOptions,
): T[]
function merge(target: object, key: MetadataKey, member: PropertyKey, options?: MemberOptions): unknown[] {
  const classValue = resolve(target, key, undefined, false) as unknown[] | undefined
  const memberValue = resolve(target, key, member, options?.static === true) as unknown[] | undefined

  return [...(classValue ?? []), ...(memberValue ?? [])]
}

/**
 * Reads and writes decorator metadata by key.
 *
 * A key is a symbol or an {@link Annotation}. Every class owns its store: a decorator on a subclass
 * never writes into its base class's metadata. Reads walk the constructor chain upwards and the
 * nearest class declaring the slot wins, so an undecorated subclass reads its base's values, a
 * decorated subclass shadows them, and a method override without its own annotation still carries
 * the base method's value. An annotation created with an `inherit` rule reads its own class only
 * (`own`) or folds every declaration along the chain (`accumulate`) instead. A slot holding
 * `undefined` counts as absent. A static member and an instance member with the same name keep
 * separate slots; `{ static: true }` addresses the static one. Inside a decorator, `get` and
 * `members` also take its context, to read what the class being defined carries so far, and
 * {@link set} writes outside a decorator, on a class or any other object.
 */
export const reflect = {
  annotate,
  set,
  get,
  effective,
  merge,
  members,
}
