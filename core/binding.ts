import { PostResolutionInterceptor } from './post_resolution_interceptor.js'
import { Factory, AsyncFactory, FactoryCreator } from './factory.js'
import { Identifier, Key } from './key.js'
import { InjectionDescriptor } from './injection.js'
import { Conditional } from './conditional.js'
import { InjectionResolver } from './injection_resolver.js'
import { Ctor } from './types.js'
import { ResolutionContext } from './resolution_context.js'
import { ContainerOps } from './container_interface.js'

let _id = 0

function newId() {
  return _id++
}

/**
 * A Binding describes a component managed by the container
 * It contains information that allows the container to resolve and instantiate the component.
 */
export interface Binding<T = any> {
  /**
   * The unique identifier of the binding.
   */
  id: number

  /**
   * Constructor injections required by the component.
   */
  injections: InjectionDescriptor<unknown>[]

  /**
   * Compiled constructor injection resolvers.
   */
  injectionResolvers: InjectionResolver<unknown>[]

  /**
   * Injectable properties for the component.
   */
  injectableProperties: Map<Identifier, InjectionDescriptor<unknown>>

  /**
   * Compiled injectable property resolvers.
   */
  propertyResolvers: Map<Identifier, InjectionResolver<unknown>>

  /**
   * Injectable methods for the component.
   */
  injectableMethods: Map<Identifier, InjectionDescriptor<unknown>[]>

  /**
   * Compiled injectable method resolvers.
   */
  methodResolvers: Map<Identifier, InjectionResolver<unknown>[]>

  /**
   * Interceptors to apply to the component after resolution.
   */
  interceptors: PostResolutionInterceptor[]

  /**
   * The profiles the binding is associated with.
   * The container will only consider bindings with profiles that match its active profiles.
   */
  profiles: Set<Identifier>

  /**
   * The scope the binding is associated with.
   */
  scopeId: Identifier

  /**
   * The names the binding is associated with.
   */
  names: Identifier[]

  /**
   * The unscoped factory for the component.
   */
  unscopedFactory: Factory<T> | AsyncFactory<T>

  /**
   * The compiled factory for the component, including the scope and
   * any interceptors configured to it
   */
  factory: Factory<T> | AsyncFactory<T>

  /**
   * The factory creator for the binding.
   */
  factoryCreator?: FactoryCreator<T>

  /**
   * The conditionals for this binding to be evaluated against.
   */
  conditionals: Conditional[]

  /**
   * The configuration class that generated this binding.
   * Used for information only.
   */
  configuredBy?: string

  /**
   * The type of the component.
   */
  type?: Function

  /**
   * Whether this binding is a configuration binding.
   */
  configuration?: boolean

  /**
   * The additional binding keys provided by this binding.
   */
  keysProvided: Key[]

  /**
   * Class that this binding extends.
   */
  extend?: Key

  /**
   * Whether this binding is the primary binding for the component.
   */
  primary?: boolean

  /**
   * Whether this binding is lazy loaded.
   */
  lazy?: boolean

  /**
   * The pre-destroy hook for the component.
   */
  preDestroy?: (value: T) => void | Promise<void>

  /**
   * The post-construct hook for the component.
   */
  postConstruct?: (value: T) => void

  /**
   * Whether to bypass post-processors for this binding.
   */
  byPassPostProcessors?: boolean

  /**
   * The labels for the binding.
   * Labels are mostly dedicated for lib/framework builders.
   */
  labels: symbol[]

  /**
   * The tags for the binding.
   * Tags are mostly dedicated for lib/framework builders.
   */
  tags: Map<symbol, unknown>

  /**
   * Whether this binding is internal.
   */
  internal: boolean

  /**
   * Detailed information about the source of the binding, including the constructor and method.
   */
  source?: { ctor: Ctor, method: string | symbol }

  /**
   * Whether this binding is a fallback binding.
   * Fallback bindings are used to provide a default implementation for a given key.
   */
  fallback?: boolean

  /**
   * The order of this binding when injected as part of an ordered collection via {@link ordered}.
   * Lower values come first. Bindings without an order value are placed last.
   */
  order?: number

  /**
   * Whether this binding is asynchronous.
   */
  async?: boolean

  /**
   * Compiled resolution context for the binding.
   */
  ctx?: ResolutionContext
}

/**
 * Creates a new binding.
 */
export function newBinding<T>(initial: Partial<Binding<T>> = {}): Binding<T> {
  return {
    id: initial.id === undefined ? newId() : initial.id,
    injections: initial.injections || [],
    injectionResolvers: initial.injectionResolvers || [],
    injectableProperties: initial.injectableProperties || new Map(),
    propertyResolvers: initial.propertyResolvers ?? new Map(),
    injectableMethods: initial.injectableMethods || new Map(),
    methodResolvers: initial.methodResolvers ?? new Map(),
    interceptors: initial.interceptors || [],
    profiles: initial.profiles || new Set(),
    names: initial.names || [],
    conditionals: initial.conditionals || [],
    configuredBy: initial.configuredBy,
    primary: initial.primary,
    lazy: initial.lazy,
    preDestroy: initial.preDestroy,
    postConstruct: initial.postConstruct,
    configuration: initial.configuration,
    keysProvided: initial.keysProvided || [],
    extend: initial.extend,
    type: initial.type,
    byPassPostProcessors: initial.byPassPostProcessors,
    scopeId: initial.scopeId!,
    unscopedFactory: initial.unscopedFactory!,
    factory: initial.factory!,
    factoryCreator: initial.factoryCreator,
    labels: initial.labels || [],
    tags: initial.tags || new Map(),
    internal: initial.internal ?? false,
    source: initial.source,
    fallback: initial.fallback,
    order: initial.order,
    async: initial.async,
    ctx: initial.ctx,
  }
}

/**
 * Returns the unique binding from the given bindings.
 * If no unique binding is found, the onKeyNoFound callback will be called.
 * If no unique binding is found, the onNoUniqueFound callback will be called.
 *
 * @param bindings - The bindings to get the unique binding from.
 * @param onKeyNoFound - The callback to call if the key is not found.
 * @param onNoUniqueFound - The callback to call if the unique binding is not found.
 */
export function getUniqueBinding<T>(
  container: ContainerOps,
  key: Key,
  onKeyNoFound?: () => void,
  onNoUniqueFound?: () => void,
): Binding<T> | undefined {
  const bindings = container.getBindings(key)
  if (bindings.length === 1) {
    return bindings[0]
  }

  if (bindings.length === 0) {
    onKeyNoFound?.()
    return undefined as unknown as Binding<T>
  }

  const unique = uniqueBinding(bindings)
  if (unique) {
    return unique
  }

  onNoUniqueFound?.()
  return undefined as unknown as Binding<T>
}

/**
 * Returns the unique binding from the given bindings.
 * If no unique binding is found, undefined is returned.
 */
function uniqueBinding<T>(bindings: Binding<T>[]): Binding<T> | undefined {
  if (bindings.length === 0) {
    return undefined as unknown as Binding<T>
  }

  if (bindings.length === 1) {
    return bindings[0]
  }

  if (bindings.length > 1) {
    if (bindings[0].primary) {
      return bindings[0]
    }
  }

  return undefined
}
