/**
 * RequestScopeStorage is a contract for a request scope storage strategy.
 * It matches Node.js AsyncLocalStorage API.
 */
export interface RequestScopeStorage<T = any> {
  run<R>(context: T, fn: () => R): R
  getStore(): T | undefined
}

/**
 * RequestScopeManager is a manager for request-scoped instances.
 */
export interface RequestScopeManager {
  /**
   * Runs the given function in a request scope.
   *
   * @param fn - The function to run.
   *
   * @returns A promise resolving to the result of the function, after all request-scoped instances are destroyed.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T>

  /**
   * Sets the storage strategy for the request scope.
   *
   * @param storage - The storage to set.
   */
  setStorage(storage: RequestScopeStorage): void
}
