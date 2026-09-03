/** The four application lifecycle events, in the order they fire across an application's life. */
export type ApplicationEvent =
  | 'application:ready'
  | 'application:run'
  | 'application:pre-shutdown'
  | 'application:shutdown'

/** All events, ordered — useful for iterating the full lifecycle. */
export const APPLICATION_EVENTS: readonly ApplicationEvent[] = [
  'application:ready',
  'application:run',
  'application:pre-shutdown',
  'application:shutdown',
]

/** Per-class map of the event → decorated method names carrying that event's lifecycle hook. */
export type LifecycleHooks = Map<ApplicationEvent, Array<string | symbol>>

// Keyed by the class's ECMAScript metadata bag (`context.metadata`, the same object as
// `Ctor[Symbol.metadata]` at runtime) — mirrors di's registrar MetadataWeakMap, so no di internals are
// touched.
const registry = new WeakMap<object, LifecycleHooks>()

/** Records that `method` on the class owning `metadata` handles `event`. Called from the decorators. */
export function recordHook(metadata: object, event: ApplicationEvent, method: string | symbol): void {
  let hooks = registry.get(metadata)
  if (hooks === undefined) {
    hooks = new Map()
    registry.set(metadata, hooks)
  }

  let methods = hooks.get(event)
  if (methods === undefined) {
    methods = []
    hooks.set(event, methods)
  }

  if (!methods.includes(method)) {
    methods.push(method)
  }
}

/** Reads the lifecycle hooks declared on a class constructor, or `undefined` when it declares none. */
export function hooksOf(ctor: Function): LifecycleHooks | undefined {
  const metadata = (ctor as { [Symbol.metadata]?: object })[Symbol.metadata]
  return metadata === undefined ? undefined : registry.get(metadata)
}
