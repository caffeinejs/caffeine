/**
 * RequestScopeManager is a manager for request-scoped instances.
 */
export interface RequestScopeManager {
  /**
   * Runs the given function in a request scope.
   *
   * The scope ends when `fn` settles, so a caller whose work outlives `fn` — a response still being streamed,
   * a body still being piped — has to keep `fn` pending until that work is done. Resolving a request-scoped key
   * once the scope has ended throws `ErrOutOfScope`.
   *
   * @param fn - The function to run.
   *
   * @returns A promise resolving to the result of the function, after all request-scoped instances are destroyed.
   *
   * @throws ErrOutOfScope When a request-scoped key is resolved after the scope has ended.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T>
}
