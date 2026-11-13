import type { ExecutionContext } from './context.js'

/**
 * RequestScopeManager is a manager for request-scoped instances.
 */
export interface RequestScopeManager {
  /**
   * Runs the given function in a request scope, which ends once the function settles: the form for a unit of work that
   * one callback holds, such as a message handled from start to finish.
   *
   * The scope ends when `fn` settles, so a caller whose work outlives `fn` — a response still being streamed,
   * a body still being piped — has to keep `fn` pending until that work is done, or use {@link enter}. Resolving a
   * request-scoped key once the scope has ended throws `ErrOutOfScope`.
   *
   * @param fn - The function to run.
   *
   * @returns A promise resolving to the result of the function, after all request-scoped instances are destroyed.
   *
   * @throws ErrIllegalScopeState when a request scope is already open in the current frame.
   * @throws ErrInvalidContainerState when the container has not initialized.
   * @throws ErrNoContextStorage when the container has no context storage.
   * @throws ErrOutOfScope When a request-scoped key is resolved after the scope has ended.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T>

  /**
   * Opens a request scope in a new frame of the container's context storage, calls `fn` in it at once, and returns
   * what `fn` returns: the form for a server whose request outlives every callback. The frame extends `context`, else
   * the current frame, so a server that puts its own slots in `context` opens one frame per request.
   *
   * The scope ends when `end`, handed to `fn`, is called: it is the caller's to call from the moment `fn` is called,
   * even when `fn` throws. Async work started in `fn` stays in the scope until then.
   *
   * `end` destroys what the scope produced, in reverse order, inside the scope's frame. It returns `undefined` when no
   * destroy hook was registered; otherwise a promise, rejecting with an `AggregateError` of the hooks that failed,
   * which the caller must handle. A second call returns what the first did.
   *
   * @throws ErrIllegalScopeState when a request scope is already open in the current frame.
   * @throws ErrInvalidContainerState when the container has not initialized.
   * @throws ErrNoContextStorage when the container has no context storage.
   */
  enter<T>(fn: (end: () => void | Promise<void>) => T, context?: ExecutionContext): T
}
