/**
 * Provider allows injecting dependencies that are resolved on every get() call.
 * It allows mixing scopes.
 * For example, a provider can inject a transient dependency into a singleton component.
 *
 * @example
 * ```ts
 * @Injectable()
 * @Lifetime(Scopes.TRANSIENT)
 * class TransientComponent {
 * }
 *
 * @Injectable([$i.provide(TransientComponent)])
 * @Lifetime(Scopes.SINGLETON)
 * class SingletonComponent {
 *   constructor(readonly transient: Provider<TransientComponent>) {}
 * }
 * ```
 */
export interface Provider<T = unknown> {
  /**
   * Resolves the wrapped key on every call. This allows mixing scopes.
   * For example, using a provider, a transient dependency can be
   * safely injected into a singleton component.
   */
  get(): T
}
