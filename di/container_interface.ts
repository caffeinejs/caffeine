import type { MethodAspect } from './aop.js'
import type { AspectSpec } from './aspect_spec.js'
import { Binding } from './binding.js'
import { BindingSpec } from './binding_spec.js'
import { HookListener } from './hooks.js'
import { Injection, ResolveInjection } from './injection.js'
import { InjectionToken, NamedToken, TokenValue } from './key.js'
import type { Module, ModuleFn } from './module.js'
import { PostProcessor } from './post_processor.js'
import { Provider } from './provider.js'
import type { Annotation } from './reflect.js'
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
   * Whether the container registers the decorated bindings (`@Injectable`, `@Configuration`, …) when it compiles.
   *
   * Off, decorators are ignored entirely: a class bound with `bind()` gets only what its binding declares.
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
  readonly hasRequestScope: boolean
  readonly values: unknown
  readonly hasValues: boolean
  readonly scopedConfig: Provider<unknown>
  readonly hasScopedConfig: boolean

  readonly [Symbol.toStringTag]: string

  [Symbol.asyncDispose](): Promise<void>

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

  getBindingsByAnnotation(annotation: symbol | Annotation<unknown, never>): BindingDescriptor[]

  has<T>(key: InjectionToken<T>): boolean

  hasScopeInGraph(key: InjectionToken, scopeID: NamedToken<Scope>): boolean

  build<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections?: (Injection | undefined | null)[]): T

  builder<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections?: (Injection | undefined | null)[]): () => T

  resolver<I extends Injection>(injection: I): () => ResolveInjection<I>

  bind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this

  bindConfig<T = unknown>(values: T): this

  bindScopedConfig<T = unknown>(provider: Provider<T>): this

  rebind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this

  aspect<C extends Ctor<MethodAspect<any>>>(cls: C, configure: (spec: AspectSpec<InstanceType<C>, C>) => void): this

  addModules(module: Module | ModuleFn, ...rest: Array<Module | ModuleFn>): void

  addProfiles(profile: string, ...profiles: string[]): void

  overrides(override: ContainerOverride): this

  resetInstances(): Promise<void>

  resetInstance(key: InjectionToken): Promise<void>

  resetBinding(binding: Binding): void | Promise<void>

  compile(): Promise<void>

  init(): Promise<void>

  dispose(): Promise<void>

  entries(): IterableIterator<[InjectionToken, Binding]>

  snapshot(): Snapshot

  restore(snap: Snapshot): void

  assertResolvable(): Promise<void>

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
  | 'getBindingsByAnnotation'
  | 'has'
  | 'values'
  | 'hasValues'
  | 'scopedConfig'
  | 'hasScopedConfig'
>

/**
 * {@link Container} binding operations available to components that run before
 * the container is initialized.
 *
 * Nothing is registered until the container compiles, so the lookups (`entries`, `getBinding*`, `wrap*`) find
 * nothing before then. A module runs while the container compiles and finds the decorated bindings and those bound
 * by hand; a feature's configure step runs before it and finds none.
 */
export type ContainerBindingOps = Pick<
  Container,
  | 'hooks'
  | 'postProcessors'
  | 'bind'
  | 'bindConfig'
  | 'hasValues'
  | 'bindScopedConfig'
  | 'hasScopedConfig'
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
  | 'getBindingsByAnnotation'
>

/**
 * What an override is handed: the container once every binding is registered and every profile and condition is
 * decided, before anything is resolved.
 */
export interface OverrideOps extends Pick<Container, 'entries' | 'getBindings' | 'has'> {
  bind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): void

  rebind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): void

  /**
   * Removes the binding registered under `key`. Bindings answering to `key` through a name or a base stay.
   */
  unbind(key: InjectionToken): void
}

/**
 * Changes the bindings of a container after they are all registered and decided, and before any is resolved.
 */
export type ContainerOverride = (ops: OverrideOps) => void | Promise<void>
