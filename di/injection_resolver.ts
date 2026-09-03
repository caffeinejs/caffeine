import type { Binding } from './binding.js'
import { ContainerOps } from './container_interface.js'
import {
  ErrInjectionStageAlreadyRegistered,
  ErrResolverAlreadyRegistered,
  ErrUnknownInjectionStage,
  ErrUnknownResolver,
} from './errors.js'
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
 * What a stage receives and may hand to the next one.
 *
 * It is an {@link InjectionResolverFactoryContext} plus the bindings selected so far, which is what lets a stage
 * sort or filter them before the chain materializes a value. A stage registered through `bindResolver` therefore
 * sees exactly the context it has always seen.
 */
export interface InjectionContext<T = unknown> extends InjectionResolverFactoryContext<T> {
  /**
   * The bindings selected for this injection, in the order the chain has put them.
   *
   * Empty for an injection that resolves without a key, such as a constant.
   */
  readonly bindings: readonly Binding<unknown>[]
}

/**
 * One step in resolving an injection.
 *
 * The chain is folded once, when the container compiles, and `next` returns the {@link InjectionResolver} the
 * rest of the chain produced. So a stage has three ways to act: transform `ctx.bindings` before calling `next`,
 * wrap the resolver `next` returns, or ignore `next` and produce the resolver itself — the last of which makes
 * it terminal.
 *
 * A stage that only transforms bindings must return `next(...)` unchanged rather than wrapping it, or it adds a
 * call frame to every resolution.
 */
export type InjectionMiddleware<T = unknown> = (
  ctx: InjectionContext<T>,
  next: (ctx: InjectionContext<T>) => InjectionResolver<T>,
  args?: unknown,
) => InjectionResolver<T>

type StageRegistration = {
  readonly middleware: InjectionMiddleware<any>
  readonly terminal: boolean
}

const stages = new Map<symbol, StageRegistration>()

/**
 * Registers an {@link InjectionMiddleware} under a name a descriptor can reference.
 *
 * @param name - The name descriptors use to reference the stage.
 * @param middleware - The stage itself.
 * @param options - `terminal` marks a stage that decides what the injection resolves to, such as collecting
 *   every binding into an array. A chain accepts only one.
 *
 * @throws {@link ErrInjectionStageAlreadyRegistered} if the name is already registered.
 */
export function registerStage(
  name: symbol,
  middleware: InjectionMiddleware<any>,
  options: { terminal?: boolean } = {},
): void {
  notNil(name)
  notNil(middleware)

  if (stages.has(name)) {
    throw new ErrInjectionStageAlreadyRegistered(name)
  }

  stages.set(name, { middleware, terminal: options.terminal ?? false })
}

/**
 * Unregisters the stage bound to the given name.
 *
 * @param name - The name to unregister.
 */
export function unregisterStage(name: symbol): void {
  stages.delete(notNil(name))
}

/**
 * Checks whether a stage is registered under the given name.
 *
 * @param name - The name to check.
 */
export function hasStage(name: symbol): boolean {
  return stages.has(name)
}

/**
 * Retrieves the stage registered under the given name.
 *
 * @param name - The name to retrieve.
 *
 * @throws {@link ErrUnknownInjectionStage} if the name is not registered.
 */
export function stageFor(name: symbol): StageRegistration {
  const stage = stages.get(name)

  if (!stage) {
    throw new ErrUnknownInjectionStage(name)
  }

  return stage
}

/**
 * Whether the stage registered under the given name decides what the injection resolves to.
 *
 * @param name - The name to check.
 *
 * @throws {@link ErrUnknownInjectionStage} if the name is not registered.
 */
export function isTerminalStage(name: symbol): boolean {
  return stageFor(name).terminal
}

/**
 * The names the built-in injection stages answer to.
 *
 * `SORT` and `PROVIDER` transform what passes through them; the rest are terminal, meaning each decides what the
 * injection resolves to, so a chain may name at most one of them.
 */
export const BuiltInStages = {
  CONFIG: Symbol('@caffeinejs/di:stage.config'),
  MANY: Symbol('@caffeinejs/di:stage.many'),
  MAP: Symbol('@caffeinejs/di:stage.map'),
  OBJECT: Symbol('@caffeinejs/di:stage.object'),
  PROVIDER: Symbol('@caffeinejs/di:stage.provider'),
  SORT: Symbol('@caffeinejs/di:stage.sort'),
  VALUE: Symbol('@caffeinejs/di:stage.value'),
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
