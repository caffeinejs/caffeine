import { ContainerOps } from './container_interface.js'
import { ErrResolverAlreadyRegistered, ErrUnknownResolver } from './errors.js'
import {
  configFactory,
  deferredFactory,
  standardFactory,
  objectFactory,
  mappedFactory,
  orderedFactory,
  providerFactory,
  valueFactory,
} from './internal/core/resolver/index.js'
import { InjectionDescriptor } from './injection.js'
import { notNil } from './internal/util/assert/index.js'
import { Identifier, Key } from './key.js'

/**
 * InjectionResolver is used to resolve components injections.
 * For example, the dependencies of a class constructor will be resolved by the container
 * using an InjectionResolver.
 */
export type InjectionResolver<T = any> = () => T

/**
 * The contextual object passed to the {@link InjectionResolverFactory}.
 */
export type InjectionResolverFactoryContext<T = unknown> = {

  /**
   * Expose {@link Container} operations.
   *
   * @readonly
   */
  readonly container: ContainerOps

  /**
   * Describes the injection and how it should be resolved.
   *
   * @readonly
   */
  readonly descriptor: InjectionDescriptor<T>

  /**
   * The {@link Key} of the component asking for the injection being described.
   *
   * @readonly
   */
  readonly key?: Key<T>

  /**
   * The kind of the injection being described.
   * Used for debugging and more detailed error messages.
   *
   * @readonly
   */
  readonly kind: 'constructor' | 'property' | 'method'

  /**
   * The member of the component asking for the injection being described.
   * The mostly used for debugging and more detailed error messages.
   * Member is empty for constructor injections.
   *
   * @defaultValue ''
   * @readonly
   */
  readonly member: Identifier

  /**
   * The index of the injection being described.
   * The mostly used for debugging and more detailed error messages.
   * Index is -1 when the position is not known.
   *
   * @defaultValue -1
   * @readonly
   */
  readonly index: number
}

/**
 * Creates {@link InjectionResolver} functions.
 */
export type InjectionResolverFactory<T = unknown> = (ctx: InjectionResolverFactoryContext<T>) => InjectionResolver<T>

/**
 * Built-in injection resolver factories.
 */
export const BuiltInResolvers = {
  CONFIG: Symbol('@caffeinejs/di:resolver.config'),
  DEFAULT: Symbol('@caffeinejs/di:resolver.default'),
  MAP: Symbol('@caffeinejs/di:resolver.map'),
  DEFER: Symbol('@caffeinejs/di:resolver.defer'),
  OBJECT: Symbol('@caffeinejs/di:resolver.object'),
  ORDERED: Symbol('@caffeinejs/di:resolver.ordered'),
  PROVIDER: Symbol('@caffeinejs/di:resolver.provider'),
  VALUE: Symbol('@caffeinejs/di:resolver.value'),
} as const

const registry = new Map<symbol, InjectionResolverFactory>()
  .set(BuiltInResolvers.CONFIG, configFactory)
  .set(BuiltInResolvers.DEFAULT, standardFactory)
  .set(BuiltInResolvers.MAP, mappedFactory)
  .set(BuiltInResolvers.DEFER, deferredFactory)
  .set(BuiltInResolvers.OBJECT, objectFactory)
  .set(BuiltInResolvers.ORDERED, orderedFactory)
  .set(BuiltInResolvers.PROVIDER, providerFactory)
  .set(BuiltInResolvers.VALUE, valueFactory)
/**
 * Binds a new {@link InjectionResolverFactory} to the given name.
 *
 * @param name - The name to bind the factory to.
 * @param factory - The factory to bind.
 *
 * @example
 * ```ts
 * bindResolver(Symbol('my-resolver'), (ctx) => {
 *   return () => {
 *     return 'my-value'
 *   }
 * })
 * ```
 *
 * @throws {@link ErrResolverAlreadyRegistered} if the name is already registered.
 */
export function bindResolver(name: symbol, factory: InjectionResolverFactory): void {
  notNil(name)
  notNil(factory)

  if (registry.has(name)) {
    throw new ErrResolverAlreadyRegistered(name)
  }

  registry.set(name, factory)
}

/**
 * Unbinds the {@link InjectionResolverFactory} bound to the given name.
 *
 * @param name - The name to unbind the factory from.
 */
export function unbindResolver(name: symbol): void {
  registry.delete(notNil(name))
}

/**
 * Checks if a {@link InjectionResolverFactory} is bound to the given name.
 *
 * @param name - The name to check if a factory is bound to.
 */
export function hasResolver(name: symbol): boolean {
  return registry.has(name)
}

/**
 * Retrieves the {@link InjectionResolverFactory} bound to the given name.
 *
 * @param name - The name to retrieve the factory for.
 *
 * @throws {@link ErrUnknownResolver} if the name is not registered.
 */
export function resolverFor(name: symbol): InjectionResolverFactory {
  const factory = registry.get(name)

  if (!factory) {
    throw new ErrUnknownResolver(name)
  }

  return factory
}
