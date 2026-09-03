import { Keys } from './symbols.js'
import { AnyClass, ClassMember } from './types.js'

interface AnnotationEntry {
  class?: unknown
  members?: Map<string | symbol, unknown>
}

interface MetadataEntry {
  class?: unknown
  members?: Map<string | symbol, unknown>
}

interface Reflect {
  /** Returns the class-level annotation value, or `undefined` if absent. */
  get<TClass extends AnyClass, C>(cls: TClass, annotation: { readonly _c?: C }): C | undefined

  /**
   * Returns the member-level annotation value, or `undefined` if absent.
   * `member` autocompletes to the declared members of `cls`.
   */
  get<TClass extends AnyClass, M>(
    cls: TClass,
    annotation: { readonly _m?: M },
    member: ClassMember<TClass>,
  ): M | undefined

  /**
   * Returns the member-level annotation value if present, falling back to the class-level value.
   *
   * @example
   * ```ts
   * reflect.getOverride(AdminCtrl, Roles, 'delete') // ['superadmin']
   * reflect.getOverride(AdminCtrl, Roles, 'list')   // ['admin']  — falls back to class
   * ```
   */
  getOverride<TClass extends AnyClass, C, M>(
    cls: TClass,
    annotation: { readonly _c?: C; readonly _m?: M },
    member: ClassMember<TClass>,
  ): C | M | undefined

  /**
   * Concatenates class-level and member-level annotation arrays — class values first.
   *
   * @example
   * ```ts
   * reflect.merge(Ctrl, Roles, 'delete') // ['user', 'admin']
   * ```
   */
  merge<TClass extends AnyClass, T>(
    cls: TClass,
    annotation: { readonly _c?: T[]; readonly _m?: T[] },
    member: ClassMember<TClass>,
  ): T[]

  annotate(metadata: DecoratorMetadata, key: symbol, value: unknown): void

  defineMetadata: typeof defineMetadata
  getMetadata: typeof getMetadata
  getMetadataOverride: typeof getMetadataOverride
}

/**
 * Binds `value` to `key` on the class's {@link Symbol.metadata}.
 *
 * A class decorator writes the class slot; a member decorator writes the member slot keyed by the
 * decorated member's name. The two do not overwrite each other.
 */
export function defineMetadata(
  context: ClassDecoratorContext | ClassMemberDecoratorContext,
  key: symbol,
  value: unknown,
): void {
  const map: Map<symbol, MetadataEntry> = ((context.metadata as any)[Keys.kMetadata] ??= new Map())

  let slot = map.get(key)
  if (!slot) {
    slot = {}
    map.set(key, slot)
  }

  if (context.kind === 'class') {
    slot.class = value
  } else {
    ;(slot.members ??= new Map()).set((context as ClassMemberDecoratorContext).name, value)
  }
}

/**
 * Returns the value stored under `key` on `cls`.
 *
 * With no `member`, this is the class slot. With a `member`, this is that member's slot only — it does
 * not fall back to the class. Use {@link getMetadataOverride} for member-then-class.
 */
export function getMetadata<T>(cls: Function, key: symbol): T | undefined
export function getMetadata<T>(cls: Function, key: symbol, member: PropertyKey): T | undefined
export function getMetadata<T>(cls: Function, key: symbol, member?: PropertyKey): T | undefined {
  const slot = metadataEntry(cls, key)
  if (member === undefined) {
    return slot?.class as T | undefined
  }

  return slot?.members?.get(member as string | symbol) as T | undefined
}

/**
 * Returns the member slot for `key` if present, otherwise the class slot.
 */
export function getMetadataOverride<T>(cls: Function, key: symbol, member: PropertyKey): T | undefined {
  const slot = metadataEntry(cls, key)
  return (slot?.members?.get(member as string | symbol) ?? slot?.class) as T | undefined
}

export const reflect: Reflect = {
  get(cls: any, annotation: any, member?: PropertyKey): any {
    const e = entry(cls, annotation)
    if (member === undefined) {
      return e?.class
    }

    return e?.members?.get(member as string | symbol)
  },

  getOverride(cls: any, annotation: any, member: PropertyKey): any {
    const e = entry(cls, annotation)
    return e?.members?.get(member as string | symbol) ?? e?.class
  },

  merge(cls: any, annotation: any, member: PropertyKey): any[] {
    const e = entry(cls, annotation)
    const classVal = e?.class as unknown[] | undefined
    const memberVal = e?.members?.get(member as string | symbol) as unknown[] | undefined

    return [...(classVal ?? []), ...(memberVal ?? [])]
  },

  annotate(metadata: DecoratorMetadata, key: symbol, value: unknown): void {
    metadata[key] = value
  },

  defineMetadata,
  getMetadata,
  getMetadataOverride,
}

function entry(cls: unknown, annotation: unknown): AnnotationEntry | undefined {
  const map = (cls as any)[Symbol.metadata]?.[Keys.kAnnotations] as Map<Function, AnnotationEntry> | undefined
  return map?.get(annotation as Function)
}

function metadataEntry(cls: Function, key: symbol): MetadataEntry | undefined {
  const map = (cls as unknown as { [Symbol.metadata]?: Record<symbol, unknown> })[Symbol.metadata]?.[Keys.kMetadata] as
    | Map<symbol, MetadataEntry>
    | undefined
  return map?.get(key)
}
