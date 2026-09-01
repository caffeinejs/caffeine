import { ContainerOps } from './container_interface.js'
import { DeferredCtor } from './deferred_ctor.js'
import { ErrResolverAlreadyRegistered, ErrUnknownResolver } from './errors.js'
import { InjectionDescriptor } from './injection.js'
import { notNil } from './internal/util/assert/index.js'
import { Identifier, InjectionToken } from './key.js'

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
   * The {@link InjectionToken} of the component asking for the injection being described.
   *
   * @readonly
   */
  readonly key?: InjectionToken<T>

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
 * The names the built-in injection resolvers answer to.
 *
 * They live here rather than beside the factories because {@link defaultResolverFor} reads two of them: moving
 * them would make this module import the built-ins, which import the factories, one of which imports this module.
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

/**
 * The resolver an unmarked descriptor gets: its own `resolver`, or a default picked from its `key`.
 *
 * The one place this rule lives. `_compile.ts` and `object.ts` both read it, so a descriptor that named no
 * resolver is treated identically wherever it is compiled.
 */
export function defaultResolverFor(descriptor: InjectionDescriptor): symbol {
  return descriptor.resolver
    ?? (descriptor.key instanceof DeferredCtor ? BuiltInResolvers.DEFER : BuiltInResolvers.DEFAULT)
}
