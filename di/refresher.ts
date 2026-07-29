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
   * Refreshes refresh-scoped instances.
   * When `label` is provided, only bindings tagged with that label are refreshed.
   * When omitted, all refresh-scoped bindings are refreshed.
   *
   * @param label - Optional symbol label to scope the refresh to a subset of bindings.
   * @returns A promise that resolves when the refresh is complete.
   */
  refresh(label?: symbol): Promise<void>
}

/**
 * Symbol key for the `SelfRefreshable` interface.
 * Using a symbol prevents accidental collisions with user-defined methods.
 */
export const kSelfRefresh: unique symbol = Symbol('@caffeinejs/di:self-refreshable')

/**
 * Opt-in interface for refresh-scoped instances that want to refresh in-place
 * instead of being destroyed and recreated.
 *
 * When `refresher.refresh()` is called, if the cached instance implements
 * `SelfRefreshable`, its `[kSelfRefresh]()` method is called and the instance
 * is kept alive. Otherwise the default behavior applies: the instance is reset
 * and recreated on the next resolution.
 *
 * @example
 * ```ts
 * import { kSelfRefresh, SelfRefreshable } from '@caffeinejs/di'
 *
 * @Injectable()
 * @Lifetime(Scopes.REFRESH)
 * class MyService implements SelfRefreshable {
 *   [kSelfRefresh]() {
 *     // reload config, reset caches, etc.
 *   }
 * }
 * ```
 */
export interface SelfRefreshable {
  [kSelfRefresh](): void | Promise<void>
}
