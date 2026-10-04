import { Keys } from './symbols.js'
import type { AnyClass, ClassMember } from './types.js'

/**
 * Key shape of a `createAnnotation` factory.
 *
 * `_c` and `_m` are phantom: never present at runtime, they only carry the class-level and
 * member-level value types for {@link reflect} to infer.
 */
export interface Annotation<C = unknown, M = C> {
  readonly _c?: C
  readonly _m?: M
}

type MetadataKey = symbol | Annotation

interface Entry {
  class?: unknown
  members?: Map<string | symbol, unknown>
}

type Store = Map<MetadataKey, Entry>

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
 * metadata of its base class.
 * @param memberName - Writes that member's slot regardless of the decorator kind
 */
function annotate(
  context: ClassDecoratorContext | ClassMemberDecoratorContext,
  key: MetadataKey,
  value: unknown,
  memberName?: string | symbol,
): void {
  const metadata = context.metadata
  if (!Object.hasOwn(metadata, Keys.kMetadata)) {
    metadata[Keys.kMetadata] = new Map()
  }

  const store = metadata[Keys.kMetadata] as Store
  let entry = store.get(key)
  if (!entry) {
    entry = {}
    store.set(key, entry)
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
 * Returns the class-level annotation value, or `undefined` if absent.
 *
 * With `member`, returns that member's value only; it does not fall back to the class value. Use
 * {@link effective} for member-then-class. `member` autocompletes to the declared members of `cls`.
 */
function get<TClass extends AnyClass, C>(cls: TClass, key: Annotation<C, unknown>): C | undefined
function get<TClass extends AnyClass, M>(
  cls: TClass,
  key: Annotation<unknown, M>,
  member: ClassMember<TClass>,
): M | undefined
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
function effective<TClass extends AnyClass, C, M>(
  cls: TClass,
  key: Annotation<C, M>,
  member: ClassMember<TClass>,
): C | M | undefined
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
function merge<TClass extends AnyClass, T>(cls: TClass, key: Annotation<T[], T[]>, member: ClassMember<TClass>): T[]
function merge(cls: AnyClass, key: MetadataKey, member: PropertyKey): unknown[] {
  const classValue = nearest(cls, key, undefined) as unknown[] | undefined
  const memberValue = nearest(cls, key, member) as unknown[] | undefined

  return [...(classValue ?? []), ...(memberValue ?? [])]
}

/**
 * Reads and writes decorator metadata by key.
 *
 * A key is a symbol or a `createAnnotation` factory. Every class owns its store: a decorator on a
 * subclass never writes into its base class's metadata. Reads walk the constructor chain from
 * `cls` upwards and the nearest class declaring the slot wins, so an undecorated subclass reads its
 * base's values, a decorated subclass shadows them, and a method override without its own
 * annotation still carries the base method's value. A slot holding `undefined` counts as absent.
 */
export const reflect = {
  annotate,
  get,
  effective,
  merge,
}
