import { Binding } from './binding.js'
import { Container } from './container_interface.js'
import { ErrScopeAlreadyRegistered } from './errors.js'
import { Factory } from './factory.js'
import { RefreshScope } from './internal/core/scope/refresh.js'
import { SingletonScope } from './internal/core/scope/singleton.js'
import { notNil } from './internal/util/assert/index.js'
import { Identifier } from './key.js'
import { ResolutionContext } from './resolution_context.js'

export const kScopeName = Symbol('@caffeinejs/di:scope.name')

/**
 * Scopes is a collection of built-in scope identifiers.
 *
 * @example
 * ```ts
 * container.bind(key).toClass(MyClass).lifetime(Scopes.REFRESH)
 * ```
 *
 * ```ts
 * @Injectable()
 * @Lifetime(Scopes.REFRESH)
 * class MyClass { }
 * ```
 */
export const Scopes = {
  SINGLETON: Symbol('@caffeinejs/di:scope.singleton'),
  TRANSIENT: Symbol('@caffeinejs/di:scope.transient'),
  REQUEST: Symbol('@caffeinejs/di:scope.request'),
  REFRESH: Symbol('@caffeinejs/di:scope.refresh'),
} as const

/**
 * ScopeFactory defines a factory function to create {@link Scope} instances.
 * Upon initialization, the {@link Container} uses the {@link ScopeFactory} to create a {@link Scope} instance for it.
 */
export type ScopeFactory = (container: Container) => Scope

/**
 * Scope is a contract for a scope implementation.
 * A scope is responsible for providing instances of a {@link Binding} to the {@link Container}.
 * A single scope instance is responsible for managing all the bindings bound to it.
 */
export interface Scope {
  /**
   * Checks if the scope is lazy.
   * A lazy scope is a scope that is not initialized until it is needed.
   *
   * @readonly
   */
  get lazy(): boolean

  /**
     * Checks if the scope is durable.
     * A durable scope should be used for durable types, like singleton.
     *
     * @readonly
     */
  get durable(): boolean

  /**
   * Provides an instance based on the given {@link ResolutionContext}.
   *
   * @param ctx - The resolution context.
   * @param factory - The factory function needed to create the instance.
   */
  provide<T>(ctx: ResolutionContext, factory: Factory<T>): T

  /**
   * Returns the cached instance for the given {@link Binding}.
   * Note that not all scopes support caching.
   *
   * @param binding - The binding to return the cached instance for.
   */
  cachedInstance<T>(binding: Binding<T>): T | undefined

  /**
   * Resets the cached instance for the given {@link Binding}.
   * Note that not all scopes support resetting.
   *
   * @param binding - The binding to reset the cached instance for.
   */
  reset(binding: Binding): void | Promise<void>

  /**
   * Configures the scope for the given {@link Binding}.
   * The {@link Container} calls this method once during the container initialization.
   *
   * @param binding - The {@link Binding} to configure the scope for.
   */
  configure(binding: Binding): void
}

const singletonFactory = (): Scope => new SingletonScope()
singletonFactory[kScopeName] = 'Singleton'

const refreshFactory = (container: Container): Scope => new RefreshScope(container)
refreshFactory[kScopeName] = 'Refresh'

const Registry = new Map<Identifier, ScopeFactory>()
  .set(Scopes.SINGLETON, singletonFactory)
  .set(Scopes.REFRESH, refreshFactory)

/**
 * Binds a {@link ScopeFactory} to the given scope identifier.
 *
 * @param scopeID - The scope identifier to bind the factory to.
 * @param factory - A {@link ScopeFactory}.
 *
 * @example
 * ```ts
 * bindScope(customScopeID, container => new CustomScope(container))
 * ```
 *
 * @throws {@link ErrScopeAlreadyRegistered} if the scope identifier is already registered.
 */
export function bindScope(scopeID: Identifier, factory: ScopeFactory): void {
  notNil(scopeID)
  notNil(factory)

  if (Registry.has(scopeID)) {
    throw new ErrScopeAlreadyRegistered(scopeID)
  }

  Registry.set(scopeID, factory)
}

/**
 * Removes the {@link ScopeFactory} bound to the given scope identifier from the registry.
 *
 * @param scopeID - The scope identifier to unbind the factory from.
 */
export function unbindScope(scopeID: Identifier): void {
  Registry.delete(notNil(scopeID))
}

/**
 * Checks if the given scope identifier exists in the registry.
 *
 * @param scopeID - The scope identifier to check.
 */
export function hasScope(scopeID: Identifier): boolean {
  return scopeID === Scopes.TRANSIENT || Registry.has(scopeID)
}

export function scopeEntries(): IterableIterator<[Identifier, ScopeFactory]> {
  return Registry.entries()
}

export function scopeLabel(scopeID: Identifier): string {
  const factory = Registry.get(scopeID)
  if (factory && kScopeName in factory) {
    return factory[kScopeName] as string
  }

  return String(scopeID)
}
