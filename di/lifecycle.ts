/**
 * A class the container calls once during `init()`, after every binding has been resolved.
 * Detected by the presence of `onBootstrap` on the class prototype; only allowed on singleton-scoped
 * bindings. Hooks run in dependency order, each awaited before the next.
 */
export interface OnBootstrap {
  onBootstrap(): void | Promise<void>
}

/**
 * A class the container calls before it is disposed, in reverse creation order. Detected by the presence of
 * `onDestroy` on the class prototype. Works for every scope that has a teardown (singleton, request).
 */
export interface OnDestroy {
  onDestroy(): void | Promise<void>
}
