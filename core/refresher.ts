/**
 * Refresher allows refreshing refresh-scoped instances within a {@link Container} instance.
 * @example
 * ```ts
 * const refresher = container.refresher
 * await refresher.refresh()
 * ```
 */
export interface Refresher {
  /**
   * Refreshes all refresh-scoped instances.
   *
   * @returns A promise that resolves when the container is refreshed.
   */
  refresh(): Promise<void>
}
