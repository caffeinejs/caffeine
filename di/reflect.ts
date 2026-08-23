import { Keys } from './symbols.js'
import { AnyClass, ClassMember } from './types.js'

interface AnnotationEntry {
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
   * Equivalent to NestJS's `Reflector.getAllAndOverride`.
   *
   * @example
   * ```ts
   * reflect.getOverride(AdminCtrl, Roles, 'delete') // ['superadmin']
   * reflect.getOverride(AdminCtrl, Roles, 'list')   // ['admin']  — falls back to class
   * ```
   */
  getOverride<TClass extends AnyClass, C, M>(
    cls: TClass,
    annotation: { readonly _c?: C, readonly _m?: M },
    member: ClassMember<TClass>,
  ): C | M | undefined

  /**
   * Concatenates class-level and member-level annotation arrays — class values first.
   * Equivalent to NestJS's `Reflector.getAllAndMerge`.
   *
   * @example
   * ```ts
   * reflect.merge(Ctrl, Roles, 'delete') // ['user', 'admin']
   * ```
   */
  merge<TClass extends AnyClass, T>(
    cls: TClass,
    annotation: { readonly _c?: T[], readonly _m?: T[] },
    member: ClassMember<TClass>,
  ): T[]

  annotate(metadata: DecoratorMetadata, key: symbol, value: unknown): void
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
}

function entry(cls: unknown, annotation: unknown): AnnotationEntry | undefined {
  const map = (cls as any)[Symbol.metadata]?.[Keys.kAnnotations] as Map<Function, AnnotationEntry> | undefined
  return map?.get(annotation as Function)
}
