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
 */
export function createAnnotation<C, M = C>(): Annotator<C, M> {
  function factory(value: C | M) {
    return (_: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
      const map: Map<Function, AnnotationEntry> = ((context.metadata as any)[Keys.kAnnotations] ??= new Map())
      let entry = map.get(factory)
      if (!entry) {
        entry = {}
        map.set(factory, entry)
      }
      if (context.kind === 'class') {
        entry.class = value
      } else {
        ;(entry.members ??= new Map()).set((context as ClassMemberDecoratorContext).name, value)
      }
    }
  }
  return factory as unknown as Annotator<C, M>
}
