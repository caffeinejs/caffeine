import { Keys } from './symbols.js'

interface AnnotationEntry {
  class?: unknown
  members?: Map<string | symbol, unknown>
}

// Phantom properties on the return type — never present at runtime.
// reflect.ts matches these structurally to infer C and M without importing a named type.
type Annotator<C, M> = ((value: C | M) => (target: unknown, context: DecoratorContext) => void) & {
  readonly _c?: C
  readonly _m?: M
}

/**
 * Low-level primitive for writing an annotation into decorator metadata.
 * Intended for use inside decorator factories.
 *
 * When `memberName` is provided the value is written to the member slot for that name,
 * regardless of context kind. Otherwise the slot is derived from context: class decorators
 * write to the class slot; member decorators write to the member slot keyed by the
 * decorated member's name.
 */
export function annotate(
  context: ClassDecoratorContext | ClassMemberDecoratorContext,
  key: Function,
  value: unknown,
  memberName?: string | symbol,
): void {
  const map: Map<Function, AnnotationEntry> = ((context.metadata as any)[Keys.kAnnotations] ??= new Map())

  let entry = map.get(key)
  if (!entry) {
    entry = {}
    map.set(key, entry)
  }

  if (memberName !== undefined) {
    ;(entry.members ??= new Map()).set(memberName, value)
  } else if (context.kind === 'class') {
    entry.class = value
  } else {
    ;(entry.members ??= new Map()).set((context as ClassMemberDecoratorContext).name, value)
  }
}

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
): ((...args: Args) =>
(target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => void) & {
  readonly _c?: T
  readonly _m?: T
}
export function createAnnotation(transform?: (...args: unknown[]) => unknown): unknown {
  return function factory(...args: unknown[]) {
    const value = transform ? transform(...args) : args[0]
    return (_: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
      annotate(context, factory, value)
    }
  }
}
