import type { MethodAspect } from './aop.js'
import type { AspectSpec } from './aspect_spec.js'
import { Binding } from './binding.js'
import { BindingSpec } from './binding_spec.js'
import { HookListener } from './hooks.js'
import { Injection, ResolveInjection } from './injection.js'
import { InjectionToken, NamedToken, TokenValue } from './key.js'
import { MetadataReader } from './metadata_reader.js'
import type { Module, ModuleFn } from './module.js'
import { PostProcessor } from './post_processor.js'
import { Provider } from './provider.js'
import { Refresher } from './refresher.js'
import { RequestScopeManager } from './request_scope_manager.js'
import type { Scope } from './scope.js'
import type { Snapshot } from './snapshot.js'
import { Ctor } from './types.js'

/**
 * Scope validation checks to apply during container initialization.
 *
 * - `'no-mix'` (default): every dependency must share the exact same scope as its consumer.
 * - `'compatible-scopes-only'`: durable-scoped consumers (e.g. singleton) cannot depend on non-durable-scoped
 *   dependencies (e.g. transient, request). The reverse is allowed.
 * - `'off'`: scope validation is disabled.
 */
export type ScopeCheckMode = 'compatible-scopes-only' | 'no-mix' | 'off'

/**
 * Options to build a {@link CaffeineIoC} container instance.
 */
export interface Options {
  /**
   * The profiles to use for the container.
   *
   * @defaultValue `[]`
   */
  profiles?: string[]

  /**
   * The default scope used for bindings that do not specify one explicitly.
   *
   * @defaultValue `Scopes.SINGLETON`
   */
  defaultScopeID?: NamedToken<Scope>

  /**
   * The default lazy loading behavior for bindings that does not specify one explicitly.
   *
   * @defaultValue `false`
   */
  lazy?: boolean

  /**
   * Custom {@link MetadataReader} for the container.
   *
   * @defaultValue `undefined`
   */
  metadataReader?: MetadataReader

  /**
   * Checks to apply during container initialization.
   *
   * @defaultValue `{ scopes: 'compatible-scopes-only' }`
   */
  checks?: {
    /**
     * Scope validation checks to apply during container initialization.
     *
     * @defaultValue `'compatible-scopes-only'`
     */
    scopes?: ScopeCheckMode

    /**
     * Whether to enable detection of circular dependencies.
     *
     * @defaultValue `true`
     */
    circularReferences?: boolean
  }

  /**
   * Whether to automatically scan and register decorated bindings on construction.
   *
   * @defaultValue `true`
   */
  decorators?: boolean

  /**
   * Modules to load. Applied during {@link Container.compile} / {@link Container.init}.
   * Further modules can be appended with {@link Container.addModules} until init.
   *
   * @defaultValue `[]`
   */
  modules?: Array<Module | ModuleFn>
}

/**
 * Describes a binding in the container and its associated key.
 */
export interface BindingDescriptor {
  key: InjectionToken
  binding: Binding
}

/**
 * Container describes the IoC container API.
 * @see {@link CaffeineIoC} for the implementation of the container and more information.
 */
export interface Container extends AsyncDisposable {
  readonly profiles: ReadonlySet<string>
  readonly size: number
  readonly hooks: HookListener
  readonly postProcessors: Set<PostProcessor>
  readonly refresher: Refresher
  readonly requestScopeManager: RequestScopeManager
  readonly ready: boolean
  readonly hasRequestScoped: boolean

  readonly [Symbol.toStringTag]: string

  [Symbol.asyncDispose](): Promise<void>

  autoWire(): void

  get<T>(key: InjectionToken<T>): T

  getOptional<T>(key: InjectionToken<T>): T | undefined

  getMany<T>(key: InjectionToken<T>): T[]

  getManyOptional<T>(key: InjectionToken<T>): T[]

  wrap<T = unknown>(key: InjectionToken<T>): Provider<T>
  wrapMany<T = unknown>(key: InjectionToken<T>): Provider<T[]>

  wrapBinding<T = unknown>(binding: Binding<T>): Provider<T>
  wrapBindings<T = unknown>(bindings: Binding<T>[]): Provider<T[]>

  getBinding<T = unknown>(key: InjectionToken<T>): Binding<T>

  getBindings<T = unknown>(key: InjectionToken<T>): Binding<T>[]

  getBindingsBy(predicate: (descriptor: BindingDescriptor) => boolean): BindingDescriptor[]

  getBindingsByLabel(label: symbol): BindingDescriptor[]

  has<T>(key: InjectionToken<T>): boolean

  hasScopeInGraph(key: InjectionToken, scopeID: NamedToken<Scope>): boolean

  build<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections?: (Injection | undefined | null)[]): T

  builder<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections?: (Injection | undefined | null)[]): () => T

  resolver<I extends Injection>(injection: I): () => ResolveInjection<I>

  bind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this

  bindValuesProvider<T = unknown>(configure: (spec: BindingSpec<T>) => void): this

  rebind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this

  aspect<C extends Ctor<MethodAspect<any>>>(cls: C, configure: (spec: AspectSpec<InstanceType<C>, C>) => void): this

  addModules(module: Module | ModuleFn, ...rest: Array<Module | ModuleFn>): void

  addProfiles(profile: string, ...profiles: string[]): void

  resetInstances(): Promise<void>

  resetInstance(key: InjectionToken): Promise<void>

  resetBinding(binding: Binding): void | Promise<void>

  compile(): Promise<void>

  init(): Promise<void>

  dispose(): Promise<void>

  entries(): IterableIterator<[InjectionToken, Binding]>

  snapshot(): Snapshot

  restore(snap: Snapshot): void

  assertResolvable(): void

  toString(): string
}

/**
 * {@link Container} operations that components can have access to safely.
 */
export type ContainerOps = Pick<
  Container,
  | 'get'
  | 'getMany'
  | 'getOptional'
  | 'wrap'
  | 'wrapMany'
  | 'wrapBinding'
  | 'wrapBindings'
  | 'getBinding'
  | 'getBindings'
  | 'getBindingsBy'
  | 'getBindingsByLabel'
  | 'has'
>

/**
 * {@link Container} binding operations available to components that run before
 * the container is initialized. Includes bind-time metadata (`wrap`, `getBinding*`)
 * so a feature can scan and wrap bindings without resolving instances.
 */
export type ContainerBindingOps = Pick<
  Container,
  | 'hooks'
  | 'postProcessors'
  | 'bind'
  | 'bindValuesProvider'
  | 'rebind'
  | 'aspect'
  | 'entries'
  | 'wrap'
  | 'wrapMany'
  | 'wrapBinding'
  | 'wrapBindings'
  | 'getBinding'
  | 'getBindings'
  | 'getBindingsBy'
  | 'getBindingsByLabel'
>
