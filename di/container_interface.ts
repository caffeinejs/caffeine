import { Identifier, Key, TypedKey, NamedKey } from './key.js'
import { Binding } from './binding.js'
import { Binder } from './binder.js'
import type { Snapshot } from './snapshot.js'
import { MetadataReader } from './metadata_reader.js'
import { HookListener } from './hooks.js'
import { Refresher } from './refresher.js'
import { RequestScopeManager } from './request_scope_manager.js'
import { PostProcessor } from './post_processor.js'
import { Injection } from './injection.js'
import { Ctor } from './types.js'
import { Provider } from './provider.js'
import { Module } from './module.js'

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
  profiles?: Identifier[]

  /**
   * The default scope used for bindings that do not specify one explicitly.
   *
   * @defaultValue `Scopes.SINGLETON`
   */
  defaultScopeID?: Identifier

  /**
   * The parent container to use for the container.
   *
   * @defaultValue `undefined`
   */
  parent?: Container

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
}

/**
 * Describes a binding in the container and its associated key.
 */
export interface BindingDescriptor {
  key: Key
  binding: Binding
}

/**
 * Container describes the IoC container API.
 * @see {@link CaffeineIoC} for the implementation of the container and more information.
 */
export interface Container {
  readonly profiles: ReadonlySet<Identifier>
  readonly parent?: Container
  readonly size: number
  readonly hooks: HookListener
  readonly postProcessors: Set<PostProcessor>
  readonly refresher: Refresher
  readonly requestScopeManager: RequestScopeManager
  readonly ready: boolean

  readonly [Symbol.toStringTag]: string

  autoWire(): void

  get<T>(key: TypedKey<T>): T
  get<T = unknown>(key: NamedKey): T

  getOptional<T>(key: TypedKey<T>): T | undefined
  getOptional<T = unknown>(key: NamedKey): T | undefined

  getMany<T>(key: TypedKey<T>): T[]
  getMany<T = unknown>(key: NamedKey): T[]

  wrap<T = unknown>(key: Key<T>): Provider<T>
  wrapMany<T = unknown>(key: Key<T>): Provider<T[]>

  getBinding<T = unknown>(key: Key<T>): Binding<T>

  getBindings<T = unknown>(key: Key<T>): Binding<T>[]

  getBindingsBy(predicate: (descriptor: BindingDescriptor) => boolean): BindingDescriptor[]

  getBindingsByLabel(label: symbol): BindingDescriptor[]

  has<T>(key: Key<T>): boolean

  hasScopeInGraph(key: Key, scopeID: Identifier): boolean

  build<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections?: (Injection | undefined | null)[]): T

  builder<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections?: (Injection | undefined | null)[]): () => T

  bind<T>(key: TypedKey<T>): Binder<T>
  bind<T = unknown>(key: NamedKey): Binder<T>

  rebind<T>(key: TypedKey<T>): Binder<T>
  rebind<T = unknown>(key: NamedKey): Binder<T>

  addModules(module: Module, ...rest: Module[]): void

  resetInstances(): Promise<void>

  resetInstance(key: Key): Promise<void>

  resetBinding(binding: Binding): void | Promise<void>

  newChild(): Container

  compile(): Promise<void>

  init(): Promise<void>

  dispose(): Promise<void>

  entries(): IterableIterator<[Key, Binding]>

  snapshot(): Snapshot

  restore(snap: Snapshot): void

  assertResolvable(): void

  toString(): string
}

/**
 * {@link Container} operations that components can have access to safely.
 */
export type ContainerOps = Pick<Container,
  | 'get'
  | 'getMany'
  | 'getOptional'
  | 'wrap'
  | 'wrapMany'
  | 'getBinding'
  | 'getBindings'
  | 'getBindingsBy'
  | 'getBindingsByLabel'
  | 'has'
>

/**
 * {@link Container} binding operations that available to components that
 * run before the container is initialized.
 */
export type ContainerBindingOps = Pick<Container,
  | 'hooks'
  | 'postProcessors'
  | 'bind'
  | 'rebind'
  | 'entries'
>
