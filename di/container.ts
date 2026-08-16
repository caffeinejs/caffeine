import { AOPBinder } from './aop_binder.js'
import { Binder } from './binder.js'
import { newBinding, Binding } from './binding.js'
import { Snapshot } from './snapshot.js'
import {
  getBindingConfigurations,
  getBindingConfiguration,
  providedBindingConfigurations,
  hasInjectable,
  decoratorConfigToBinding,
} from './decorators/registrar/index.js'
import {
  ErrRepeatedInjectableConfiguration,
  ErrNoUniqueInjectionForKey,
  ErrNoResolutionForKey,
  ErrInvalidBinding,
  ErrScopeNotRegistered,
  ErrOrphanedBindingConfig,
  ErrMultiplePrimary,
  ErrInvalidContainerState,
  ErrInjectableBase,
} from './errors.js'
import { Injection, InjectionDescriptor } from './injection.js'
import { InjectionResolver } from './injection_resolver.js'
import { SingletonScope, RefreshScope, RequestScope } from './internal/core/scope/index.js'
import { Scopes, scopeEntries, Scope } from './scope.js'
import { checkScopes } from './internal/core/scope/validations.js'
import { PostProcessor } from './post_processor.js'
import { keyStr, Key, TypedKey, NamedKey, Identifier } from './key.js'
import { notNil } from './internal/util/assert/index.js'
import { MetadataReader } from './metadata_reader.js'
import { Ctor } from './types.js'
import { BindingDescriptor, Container, Options, ScopeCheckMode } from './container_interface.js'
import { HookListener } from './hooks.js'
import { Module, runModule } from './module.js'
import { Conditional, ConditionContext } from './conditional.js'
import { Refresher } from './refresher.js'
import { RequestScopeManager } from './request_scope_manager.js'
import { isConstructable } from './internal/util/clazz/clazz.js'
import { checkCircularReferences, checkIfContainerIsResolvable, checkAspects } from './_checks.js'
import { compileDescriptorResolver, compileFactory, compileInjectionResolvers } from './_compile.js'
import { buildAOPInterceptors, kAspectLabel, type MethodAspect } from './aop.js'
import { Provider } from './provider.js'
import { Keys } from './symbols.js'

const DEFAULT_OPTIONS: Partial<Options> = {
  defaultScopeID: Scopes.SINGLETON,
  lazy: false,
  decorators: true,
  checks: {
    circularReferences: true,
    scopes: 'compatible-scopes-only',
  },
}

/**
 * CaffeineIoC IoC container implementation of the {@link Container} interface.
 * A container must always be initialized before it can be used.
 * Upon initialization, it is no longer possible to register new bindings.
 *
 * @sealed
 */
export class CaffeineIoC implements Container {
  private readonly modules: Module[]
  private readonly registry = new Map<Key, Binding>()
  private readonly bindings = new Map<Key, Binding[]>()
  private readonly bindingsByLabel = new Map<symbol, [Key, Binding][]>()
  private readonly metadataReader: MetadataReader
  private readonly lazy?: boolean
  private readonly circularReferences: boolean
  private readonly scopeID: Identifier
  private readonly scopes: Map<Identifier, Scope>
  private readonly scopeCheckMode: ScopeCheckMode

  readonly postProcessors: Set<PostProcessor> = new Set()
  readonly hooks: HookListener = new HookListener()
  readonly profiles: ReadonlySet<Identifier>
  readonly parent?: Container
  readonly refresher!: Refresher
  readonly requestScopeManager!: RequestScopeManager

  private _ready = false
  private _initializing = false
  private _compiled = false
  private _pendingConditionals: { key: Key, binding: Binding, fallback: boolean, providedByConfig?: Key }[] = []
  private _pendingConfigKeys: Map<Key, Key[]> = new Map()
  private _pendingConditionalKeys = new Set<Key>()
  private _sortedAsyncEntries: [Key, Binding][] = []
  private _aspectScopeCache: Set<Identifier> | null = null

  /**
   * Creates a new container instance.
   *
   * @param modules - The modules to load into the container.
   */
  constructor(...modules: Module[])
  /**
   * Creates a new container instance.
   *
   * @param options - The options to configure the container.
   * @param modules - The modules to load into the container.
   */
  constructor(options: Partial<Options>, ...modules: Module[])
  /**
   * Creates a new container instance.
   *
   * @param optionsOrModuleFns - The options or modules to configure the container.
   * @param modules - The modules to load into the container.
   */
  constructor(optionsOrModuleFns: Partial<Options> | Module = {}, ...modules: Module[]) {
    const isModuleFn = typeof optionsOrModuleFns === 'function'
    const opts = { ...DEFAULT_OPTIONS, ...(isModuleFn ? {} : optionsOrModuleFns) } as Options
    const allModuleFns = isModuleFn ? [optionsOrModuleFns, ...modules] : modules

    this.parent = opts.parent
    this.profiles = new Set(opts.profiles ?? [])
    this.lazy = opts.lazy
    this.circularReferences = opts.checks?.circularReferences ?? false
    this.scopeCheckMode = opts.checks?.scopes ?? 'no-mix'
    this.scopeID = opts.defaultScopeID ?? Scopes.SINGLETON
    this.metadataReader = opts.metadataReader || (() => ({}))
    this.scopes = new Map<Identifier, Scope>()
    this.modules = allModuleFns

    for (const [id, factory] of scopeEntries()) {
      this.scopes.set(id, factory(this))
    }

    if (opts.decorators) {
      this.autoWire()
    }

    // Binding internal components to the container to facilitate their usage across components.
    // Calling .size will consider these bindings as well.

    if (this.scopes.has(Scopes.REFRESH)) {
      const refresher = { refresh: this.refresh.bind(this) }

      this.refresher = refresher
      this.bind(Keys.kRefresher).toValue(refresher)
        .byPassPostProcessors()
        .internal()
    }

    if (this.scopes.has(Scopes.REQUEST)) {
      const requestScope = this.scopes.get(Scopes.REQUEST) as RequestScope
      const requestScopeManager: RequestScopeManager = {
        run: requestScope.run.bind(requestScope),
        setStorage: requestScope.setStorage.bind(requestScope),
      }

      this.requestScopeManager = requestScopeManager
      this.bind(Keys.kRequestScopeManager).toValue(requestScopeManager)
        .byPassPostProcessors()
        .internal()
    }
  }

  get [Symbol.toStringTag]() {
    return CaffeineIoC.name
  }

  /**
   * Whether the container is ready to be used.
   */
  get ready(): boolean {
    return this._ready
  }

  /**
   * The number of bindings registered in the container,
   * including built-in components.
   */
  get size(): number {
    return this.registry.size
  }

  /**
   * Get a single instance for the given key.
   * If multiple bindings are registered for the same key, the primary binding will be used to resolve the instance.
   *
   * @param key - The key to resolve the instance for.
   *
   * @throws {@link ErrInvalidContainerState} if the container is not initialized
   * @throws {@link ErrNoResolutionForKey} if no binding is registered for the given key
   * @throws {@link ErrNoUniqueInjectionForKey} if multiple bindings are registered for the same key and none is primary
   */
  get<T>(key: TypedKey<T>): T
  get<T = unknown>(key: NamedKey): T
  get<T = unknown>(key: Key): T {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot resolve: container has not been initialized — call init() first')
    }

    const bindings = this.getBindings<T>(key as TypedKey<T>)
    if (bindings.length === 0) {
      throw new ErrNoResolutionForKey(`Cannot resolve key '${keyStr(key)}'`)
    }

    const b = bindings[0]
    if (bindings.length > 1) {
      if (b.primary) {
        return b.factory(b.ctx!) as T
      }

      throw new ErrNoUniqueInjectionForKey(key)
    }

    return b.factory(b.ctx!) as T
  }

  /**
   * Get a single instance for the given key.
   * If no binding is registered for the given key, undefined will be returned.
   * If multiple bindings are registered for the same key, the primary binding will be used to resolve the instance.
   *
   * @param key - The key to resolve the instance for.
   *
   * @throws {@link ErrInvalidContainerState} if the container is not initialized
   * @throws {@link ErrNoUniqueInjectionForKey} if multiple bindings are registered for the same key and none is primary
   */
  getOptional<T = unknown>(key: Key<T>): T | undefined {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot resolve: container has not been initialized — call init() first')
    }

    const bindings = this.getBindings<T>(key)
    if (bindings.length === 0) {
      return undefined as T
    }

    const b = bindings[0]
    if (bindings.length > 1) {
      if (b.primary) {
        return b.factory(b.ctx!) as T
      }

      throw new ErrNoUniqueInjectionForKey(key)
    }

    return b.factory(b.ctx!) as T
  }

  /**
   * Get all instances for the given key.
   *
   * @param key - The key to resolve the instances for.
   *
   * @throws {@link ErrInvalidContainerState} if the container is not initialized
   * @throws {@link ErrNoResolutionForKey} if no binding is registered for the given key
   */
  getMany<T>(key: TypedKey<T>): T[]
  getMany<T = unknown>(key: NamedKey): T[]
  getMany<T>(key: Key<T>): T[] {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot resolve: container has not been initialized — call init() first')
    }

    const bindings = this.getBindings<T>(key)
    if (bindings.length === 0) {
      throw new ErrNoResolutionForKey(`Cannot resolve key "${keyStr(key)}"`)
    }

    if (bindings.length === 1) {
      return [bindings[0].factory(bindings[0].ctx!) as T]
    }

    const out = new Array<T>(bindings.length)
    for (let i = 0; i < bindings.length; i++) {
      out[i] = bindings[i].factory(bindings[i].ctx!) as T
    }

    return out
  }

  /**
   * Get all instances for the given key, or an empty array if no binding is registered for the given key.
   *
   * @param key - The key to resolve the instances for.
   *
   * @returns An array of instances of {@link T}.
   *
   * @throws {@link ErrInvalidContainerState} if the container is not initialized
   */
  getManyOptional<T>(key: TypedKey<T>): T[]
  getManyOptional<T = unknown>(key: NamedKey): T[]
  getManyOptional<T>(key: Key<T>): T[] {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot resolve: container has not been initialized — call init() first')
    }

    const bindings = this.getBindings<T>(key)
    if (bindings.length === 0) {
      return [] as T[]
    }

    if (bindings.length === 1) {
      return [bindings[0].factory(bindings[0].ctx!) as T]
    }

    const out = new Array<T>(bindings.length)
    for (let i = 0; i < bindings.length; i++) {
      out[i] = bindings[i].factory(bindings[i].ctx!) as T
    }

    return out
  }

  /**
   * Wraps the given key in a {@link Provider} that returns an instance on every {@link Provider.get} call.
   *
   * @param key - The key to wrap in a {@link Provider}.
   *
   * @returns A {@link Provider} of {@link T}.
   */
  wrap<T = unknown>(key: Key<T>): Provider<T> {
    const binding = this.getBinding(key)
    if (binding === undefined) {
      throw new ErrNoResolutionForKey(`Cannot wrap key "${keyStr(key)}": no binding registered for key "${keyStr(key)}"`)
    }

    return {
      get: () => binding.factory(binding.ctx!) as T,
    }
  }

  /**
   * Wraps the given key in a {@link Provider} that returns an array of
   * instances on every {@link Provider.get} call.
   *
   * @param key - The key to wrap in a {@link Provider}.
   *
   * @returns A {@link Provider} of {@link T}[].
   */
  wrapMany<T = unknown>(key: Key<T>): Provider<T[]> {
    const bindings = this.getBindings<T>(key)
    if (bindings.length === 0) {
      throw new ErrNoResolutionForKey(`Cannot wrap key "${keyStr(key)}": no binding registered for key "${keyStr(key)}"`)
    }

    if (bindings.length === 1) {
      return {
        get: () => [bindings[0].factory(bindings[0].ctx!)] as T[],
      }
    }

    return {
      get: () => {
        const results = new Array<unknown>(bindings.length)
        for (let i = 0; i < bindings.length; i++) {
          results[i] = bindings[i].factory(bindings[i].ctx!)
        }
        return results as T[]
      },
    }
  }

  /**
   * Wraps the given binding in a {@link Provider} that returns an instance on every {@link Provider.get} call.
   *
   * @param binding - The binding to wrap in a {@link Provider}.
   *
   * @returns A {@link Provider} of {@link T}.
   */
  wrapBinding<T = unknown>(binding: Binding<T>): Provider<T> {
    return {
      get: () => binding.factory(binding.ctx!) as T,
    }
  }

  /**
   * Wraps the given bindings in a {@link Provider} that returns an array of instances on every {@link Provider.get} call.
   *
   * @param bindings - The bindings to wrap in a {@link Provider}.
   *
   * @returns A {@link Provider} of {@link T}[].
   */
  wrapBindings<T = unknown>(bindings: Binding<T>[]): Provider<T[]> {
    if (bindings.length === 1) {
      return {
        get: () => [bindings[0].factory(bindings[0].ctx!)] as T[],
      }
    }

    return {
      get: () => {
        const results = new Array<unknown>(bindings.length)
        for (let i = 0; i < bindings.length; i++) {
          results[i] = bindings[i].factory(bindings[i].ctx!)
        }
        return results as T[]
      },
    }
  }

  /**
   * Get the binding for the given key.
   * If multiple bindings are registered for the same key, the primary binding will be returned.
   *
   * @param key - The key to resolve the binding for.
   *
   * @throws {@link ErrNoResolutionForKey} if no binding is registered for the given key
   */
  getBinding<T = unknown>(key: Key<T>): Binding<T> {
    const bindings = this.getBindings<T>(key as TypedKey<T>)

    if (bindings.length === 0) {
      return undefined as unknown as Binding<T>
    }

    if (bindings.length > 1) {
      if (bindings[0].primary) {
        return bindings[0]
      }

      throw new ErrNoUniqueInjectionForKey(key)
    }

    return bindings[0]
  }

  /**
   * Get all bindings for the given key.
   * If multiple bindings are registered for the same key, all bindings will be returned.
   *
   * @param key - The key to resolve the bindings for.
   */
  getBindings<T = unknown>(key: Key<T>): Binding<T>[] {
    const bindings = this.bindings.get(key)
    if (bindings && bindings.length > 0) {
      return bindings as Binding<T>[]
    }

    if (this.parent) {
      return this.parent.getBindings(key)
    }

    return []
  }

  /**
   * Get all bindings that match the given predicate.
   *
   * @param predicate - The predicate to match the bindings against.
   */
  getBindingsBy(predicate: (descriptor: BindingDescriptor) => boolean): BindingDescriptor[] {
    const result: BindingDescriptor[] = []
    for (const [key, binding] of this.registry.entries()) {
      const descriptor: BindingDescriptor = { key, binding }
      if (predicate(descriptor)) {
        result.push(descriptor)
      }
    }

    return result
  }

  /**
   * Get all bindings that have the given label.
   *
   * @param label - The label to match the bindings against.
   */
  getBindingsByLabel(label: symbol): BindingDescriptor[] {
    return (this.bindingsByLabel.get(label) ?? []).map(([key, binding]) => ({ key, binding }))
  }

  /**
   * Checks if a binding is registered for the given key.
   * It will automatically check the parent container if the binding is not registered in this one.
   *
   * @param key - The key to check for.
   */
  has<T>(key: Key<T>): boolean {
    return this.registry.has(key) || (this.parent?.has(key) ?? false)
  }

  /**
   * Checks if the given key has the given scope within its dependency graph.
   *
   * @param key - The key to check for.
   * @param scopeID - The scope to check for.
   *
   * @returns True if the key or any of its underlying dependencies have the given scope.
   */
  hasScopeInGraph(key: Key, scopeID: Identifier): boolean {
    if (!this.has(key)) {
      return false
    }

    if (this._aspectScopeCache !== null && this._aspectScopeCache.has(scopeID)) {
      return true
    }

    return this.walkScopeGraph(new Set(), this.getBindings(key), scopeID)
  }

  /**
   * Builds a new instance of the given arbitrary constructor or function, using registered bindings
   * within the container to inject dependencies.
   * It can build an instance of a class, a function, or a plain object, registered or not.
   * Dependencies can be specified using injection functions.
   * It will only inject the dependencies that are specified.
   * For example, this is valid: .builder(MyClass, [undefined, Dep, undefined]).
   *
   * @param ctor - The constructor or function to build an instance of.
   * @param injections - The injections to use to build the instance.
   *
   * @example
   * ```ts
   * @Injectable()
   * class RegisteredService {}
   *
   * class Unregistered {
   *   constructor(readonly service: RegisteredService, readonly repo: Repository) {}
   * }
   *
   * const instance = container.build(Unregistered, [RegisteredService, $i.optional(Repository)])
   * ```
   */
  build<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections: (Injection | undefined | null)[] = []): T {
    return this.builder(ctor, injections)()
  }

  /**
   * Creates an optimized pre-compiled builder for the given constructor or function.
   * The builder can be used to create instances on demand.
   * It will only inject the dependencies that are specified. Pass null or undefined to skip injection of a dependency.
   * For example, this is valid: .builder(MyClass, [undefined, Dep, undefined]).
   *
   * @param ctor - The constructor or function to build an instance of.
   * @param injections - The injections to use to build the instance.
   *
   * @returns A function that can be used to create instances on demand.
   *
   * @example
   * ```ts
   * @Injectable()
   * class RegisteredService {}
   *
   * class Unregistered {
   *   constructor(readonly service: RegisteredService, readonly repo: Repository) {}
   * }
   *
   * const builder = container.builder(Unregistered, [RegisteredService, $i.optional(Repository)])
   * const instance = builder()
   * ```
   */
  builder<T>(ctor: Ctor<T> | ((...args: any[]) => T), injections: (Injection | undefined | null)[] = []): () => T {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot build: container has not been initialized — call init() first')
    }

    const isClazz = isConstructable(ctor)
    if (injections.length === 0) {
      return () => isClazz ? new ctor() : ctor() as T
    }

    const resolvers = new Array<InjectionResolver>(injections.length)
    for (let i = 0; i < injections.length; i++) {
      const dep = injections[i]
      if (dep === null || dep === undefined) {
        const v = dep
        resolvers[i] = () => v as unknown
        continue
      }

      const injection = typeof dep === 'object' ? (dep as InjectionDescriptor) : { key: dep }

      resolvers[i] = compileDescriptorResolver(this, injection.key as Key, injection, 'constructor', '', i)
    }

    const deps = new Array<unknown>(resolvers.length)
    for (let i = 0; i < resolvers.length; i++) {
      deps[i] = resolvers[i]()
    }

    if (isConstructable(ctor)) {
      return () => new ctor(...deps) as T
    }

    return () => ctor(...deps) as T
  }

  /**
   * Binds a new type to given key, making it managed by the container.
   *
   * @param key - The key to bind the type to.
   *
   * @returns A {@link Binder} to configure the binding.
   */
  bind<T>(key: TypedKey<T>): Binder<T>
  bind<T = unknown>(key: NamedKey): Binder<T>
  bind<T>(key: Key<T>): Binder<T> {
    notNil(key)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot bind: container is already initialized — call init() first')
    }

    const type = getBindingConfiguration(key)
    const binding = newBinding<T>(type ? decoratorConfigToBinding(type) : {})

    return new Binder<T>(key, binding, b => this.configureBinding(key as Key, b))
  }

  /**
   * Registers a values provider under the well-known internal key, making it available for
   * `$i.config` injections throughout the container.
   *
   * Syntax sugar for `bind(kValuesProvider)` — returns a {@link Binder} so the caller can
   * choose any factory strategy and lifetime.
   *
   * @example
   * ```ts
   * di.bindValuesProvider<AppConfig>().toValue(configHandle)
   * di.bindValuesProvider<AppConfig>().toClass(MyConfigProvider).lifetime(Scopes.Singleton)
   * ```
   */
  bindValuesProvider<T = unknown>(): Binder<T> {
    return this.bind<T>(Keys.kValuesProvider)
  }

  /**
   * Rebinds the given key with a new binding.
   * The existing binding for the given key will be unregistered.
   * For testing purposes.
   *
   * @param key - The key to rebind.
   *
   * @returns A {@link Binder} to configure the binding.
   */
  rebind<T>(key: TypedKey<T>): Binder<T>
  rebind<T = unknown>(key: NamedKey): Binder<T>
  rebind<T>(key: Key<T>): Binder<T> {
    notNil(key)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot rebind: container is already initialized — call init() first')
    }

    if (this.registry.has(key)) {
      this.unref(key)
    }

    this._pendingConditionals = this._pendingConditionals.filter(e => e.key !== key)
    this._pendingConfigKeys.delete(key)

    return this.bind(key as TypedKey<T>)
  }

  /**
   * Registers an AOP {@link MethodAspect}.
   *
   * @param cls - The aspect class to register. Must implement {@link MethodAspect}.
   *
   * @throws {@link ErrInvalidContainerState} if the container is already initialized
   *
   * @example
   * ```ts
   * container
   *   .aspect(LoggingAspect)
   *   .toSelf()
   *   .pointcuts($aop.forClass(UserService, 'findUser'))
   *
   * container
   *   .aspect(MetricsAspect)
   *   .toAsyncFactory(async () => new MetricsAspect(await buildClient()))
   *   .pointcuts($aop.forClass(OrderService, $aop.matchMethodPattern(/^find/)))
   * ```
   */
  aspect<T extends MethodAspect<any>>(cls: Ctor<T>): AOPBinder<T> {
    notNil(cls)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot bind: container is already initialized — call init() first')
    }

    const binding = newBinding<T>({ type: cls, labels: [kAspectLabel] })

    return new AOPBinder<T>(cls, binding, b => this.configureBinding(cls, b))
  }

  /**
   * Adds new {@link Module}s to the container.
   * Modules will be applied during {@link init}.
   *
   * @param module - The module to add.
   * @param rest - Additional modules to add.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already been initialized
   */
  addModules(module: Module, ...rest: Module[]): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot add modules once the container has been initialized')
    }

    this.modules.push(module, ...rest)
  }

  /**
   * Creates a new child container from this one, sharing the same configuration.
   */
  newChild(): CaffeineIoC {
    const child = new CaffeineIoC({
      lazy: this.lazy,
      defaultScopeID: this.scopeID,
      profiles: [...this.profiles],
      parent: this,
      decorators: false,
      checks: { scopes: this.scopeCheckMode, circularReferences: this.circularReferences },
      metadataReader: this.metadataReader,
    })

    for (const value of this.postProcessors) {
      child.postProcessors.add(value)
    }

    return child
  }

  /**
   * Captures a snapshot of all non-internal bindings in their current state.
   * Works at any point — pre-init or post-init.
   * For testing purposes.
   */
  snapshot(): Snapshot {
    const entries: [Key, Binding][] = []

    for (const [key, binding] of this.registry) {
      if (binding.internal) {
        continue
      }

      const isDerived
        = typeof key === 'function'
          || binding.type !== undefined
          || binding.factoryCreator !== undefined
          || binding.source !== undefined

      entries.push([key, {
        ...binding,
        factory: isDerived ? undefined! : (binding.unscopedFactory ?? binding.factory),
        unscopedFactory: undefined!,
        ctx: undefined,
        injectionResolvers: [],
        propertyResolvers: new Map(),
        methodResolvers: new Map(),
      }])
    }

    return new Snapshot(entries)
  }

  /**
   * Restores bindings from the given snapshot into the container.
   * Must be called before {@link init}.
   */
  restore(snap: Snapshot): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot restore: container is already initialized')
    }

    for (const [key, binding] of snap.entries()) {
      this.configureBinding(key, binding)
    }
  }

  /**
   * Resets all instances in the container.
   * Async bindings will be automatically re-initialized.
   */
  async resetInstances(): Promise<void> {
    await Promise.all([...this.registry.entries()].map(([, binding]) => this.resetBinding(binding)))
  }

  /**
   * Resets the instance bound to the given key.
   * Async bindings associated with the key will be automatically re-initialized.
   */
  async resetInstance(key: Key): Promise<void> {
    notNil(key)

    const bindings = this.getBindings(key as TypedKey<any>)
    const asyncBindings = bindings.filter(b => b.async)

    if (asyncBindings.length === 0) {
      await Promise.all(
        bindings.map((b: Binding) => this.preDestroyBinding(b)
          .finally(() => this.scopes.get(b.scopeID)
            ?.reset(b))),
      )

      return
    }

    const asyncIds = new Set(asyncBindings.map(b => b.id))
    for (const [k, b] of this._sortedAsyncEntries.filter(([, b]) => asyncIds.has(b.id))) {
      await this.preDestroyBinding(b)
        .finally(() => this.resolveAsyncBinding(k, b))
    }

    await Promise.all(
      bindings
        .filter(b => !b.async)
        .map((b: Binding) => this.preDestroyBinding(b)
          .finally(() => this.scopes.get(b.scopeID)
            ?.reset(b))),
    )

    return
  }

  /**
   * Resets the instance bound to the given binding.
   * If the binding is async, the instance will be automatically re-initialized.
   */
  async resetBinding(binding: Binding): Promise<void> {
    if (binding.async) {
      return this.preDestroyBinding(binding)
        .finally(() => this.resolveAsyncBinding(binding.ctx!.key, binding))
    }

    return this.preDestroyBinding(binding)
      .finally(() => this.scopes.get(binding.scopeID)
        ?.reset(binding))
  }

  /**
   * Registers decorated bindings into the container.
   * autoWire() is called automatically when the container is created if `decorators` option is true (default).
   */
  autoWire(): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot register binding: container is already initialized')
    }

    const pendingFallbacks: [Key, Binding][] = []
    const pendingFallbackProvided: [Key, Binding][] = []

    for (const [key, config] of getBindingConfigurations(this.profiles)) {
      if (!hasInjectable(key)) {
        throw new ErrOrphanedBindingConfig(key)
      }

      const binding = config.binding()

      this.hooks.emit('onSetup', { key, binding })

      if (binding.fallback) {
        if (binding.conditionals.length > 0) {
          if (binding.configuration) {
            this._pendingConfigKeys.set(key, binding.keysProvided ?? [])
          }
          this._pendingConditionals.push({ key, binding, fallback: true })
        } else {
          pendingFallbacks.push([key, binding])
        }
        continue
      }

      if (!this.isRegistrable(binding)) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      if (binding.conditionals.length > 0) {
        if (binding.configuration) {
          this._pendingConfigKeys.set(key, binding.keysProvided ?? [])
        }
        this._pendingConditionals.push({ key, binding, fallback: false })
      } else {
        this.configureBinding(key, binding)
        this.hooks.emit('onBindingRegistered', { key, binding })
      }
    }

    for (const [key, config] of providedBindingConfigurations(this.profiles)) {
      const binding = config.binding()

      this.hooks.emit('onSetup', { key, binding })

      const configKey = this.findPendingConfigForKey(key)

      if (binding.fallback) {
        if (binding.conditionals.length > 0 || configKey !== undefined) {
          this._pendingConditionals.push({ key, binding, fallback: true, providedByConfig: configKey })
        } else {
          pendingFallbackProvided.push([key, binding])
        }
        continue
      }

      if (configKey !== undefined) {
        this._pendingConditionals.push({ key, binding, fallback: false, providedByConfig: configKey })
        continue
      }

      if (!this.isRegistrable(binding)) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      if (binding.conditionals.length > 0) {
        this._pendingConditionals.push({ key, binding, fallback: false })
      } else {
        if (this.registry.has(key)) {
          throw new ErrRepeatedInjectableConfiguration(
            `Found multiple bindings with the same injection key "${keyStr(key)}" configured at "${binding.configuredBy}"`,
          )
        }

        this.configureBinding(key, binding)
        this.hooks.emit('onBindingRegistered', { key, binding })
      }
    }

    for (const [key, binding] of pendingFallbacks) {
      this.hooks.emit('onSetup', { key, binding })

      if (this.registry.has(key) || !this.isRegistrable(binding)) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      this.configureBinding(key, binding)
      this.hooks.emit('onBindingRegistered', { key, binding })
    }

    for (const [key, binding] of pendingFallbackProvided) {
      this.hooks.emit('onSetup', { key, binding })

      if (this.registry.has(key)) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      if (!this.isRegistrable(binding)) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      this.configureBinding(key, binding)
      this.hooks.emit('onBindingRegistered', { key, binding })
    }

    this.hooks.emit('onSetupComplete')
  }

  /**
   * Initializes the container.
   * It compiles the bindings and prepares them for resolution,
   * so it must be called before the container can be used for resolution.
   */
  async init(): Promise<void> {
    if (this._ready) {
      return
    }

    await this.compile()

    this._sortedAsyncEntries = this.sortAsyncBindings()
    this._initializing = true

    try {
      await this.resolveAsyncBindings()

      const eagerResolutions: Promise<void>[] = []
      for (const [, binding] of this.registry.entries()) {
        if (binding.async) {
          continue
        }

        const scope = this.scopes.get(binding.scopeID)
        if (scope === undefined && binding.scopeID !== Scopes.TRANSIENT) {
          throw new ErrScopeNotRegistered(binding.scopeID)
        }

        if (binding.lazy || (scope?.lazy ?? true)) {
          continue
        }

        eagerResolutions.push(
          Promise.resolve()
            .then(() => binding.factory(binding.ctx!) as unknown)
            .then(instance => {
              this.hooks.emit('onBindingInitialized', {
                key: binding.ctx!.key,
                binding,
                instance,
                async: false,
              })
            })
            .catch(error => {
              this.hooks.emit('onBindingInitializationFailed', {
                key: binding.ctx!.key,
                binding,
                error,
                async: false,
              })
              throw error
            }),
        )
      }

      await Promise.all(eagerResolutions)
      this._ready = true
    } finally {
      this._initializing = false
    }
  }

  /**
   * Disposes the container, destroying all instances and executing destruction hooks.
   */
  async dispose(): Promise<void> {
    const entries = Array.from(this.registry.entries())
    const disposers: Promise<void>[] = []

    for (const [, binding] of entries) {
      if (binding.preDestroy) {
        disposers.push(
          this
            .preDestroyBinding(binding)
            .finally(() => this.scopes.get(binding.scopeID)?.reset(binding)))
      } else {
        disposers.push(Promise.resolve(this.scopes.get(binding.scopeID)?.reset(binding)))
      }
    }

    return Promise.allSettled(disposers)
      .then(async results => {
        const rejections = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (rejections.length === 0) {
          return
        }

        return Promise.reject(
          new AggregateError(
            rejections.map(r => r.reason),
            `${rejections.length} component(s) failed during disposal`,
          ),
        )
      })
      .finally(() => {
        this._ready = false
        this.hooks.emit('onDisposed')
      })
  }

  /**
   * Asserts that all bindings are resolvable.
   * Usually called after all bindings have been registered and before the container is initialized.
   *
   * @throws {@link ErrUnresolvableDependencies} if any binding is not resolvable
   */
  assertResolvable(): void {
    checkIfContainerIsResolvable(this.registry, this.getBindings.bind(this))
  }

  /**
   * Returns an iterator over the bindings in the container.
   */
  entries(): IterableIterator<[Key, Binding]> {
    return this.registry.entries()
  }

  /**
   * Returns a string describing the container's bindings.
   * Useful for debugging.
   */
  toString(): string {
    return (
      `${this.constructor.name}(profiles=[${[...this.profiles].map(String)
        .join(', ')}], count=${this.size}) {`
        + '\n'
        + Array.from(this.entries())
          .map(
            ([key, binding]) =>
              `${keyStr(key)}: `
              + `names=[${binding.names?.map(x => keyStr(x))
                .join(', ')}], `
                + `scope=${binding.scopeID.toString()}, `
                + `injections=[${binding.injections
                  ?.map(
                    spec =>
                      '[' + keyStr(spec.key) + `: optional=${spec.optional || false}, multiple=${spec.multiple || false}]`,
                  )
                  .join(', ')}], `
                  + `lazy=${binding.lazy}, `
                  + `factory=${binding.factory?.constructor?.name}`,
          )
          .join('\n, ')
          + '\n}'
    )
  }

  [Symbol.iterator](): IterableIterator<[Key, Binding]> {
    return this.registry.entries()
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }

  /**
   * Configures a binding for the given key.
   *
   * @param key - The key to configure the binding for.
   * @param config - The binding configuration.
   */
  private configureBinding<T>(key: Key<T>, config: Binding<T>): void {
    notNil(key)
    notNil(config)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot register binding: container is already initialized')
    }

    if (config.async) {
      if (config.lazy) {
        throw new ErrInvalidBinding(`Cannot configure binding "${keyStr(key)}": async bindings cannot be lazy`)
      }

      const allowed
        = config.scopeID === undefined || config.scopeID === Scopes.SINGLETON || config.scopeID === Scopes.REFRESH
      if (!allowed) {
        throw new ErrInvalidBinding(
          `Cannot configure async binding "${keyStr(key)}": async bindings can only be singleton or refresh scoped`,
        )
      }

      if (config.injectableProperties?.size || 0 > 0
        || config.injectableMethods?.size || 0 > 0) {
        throw new ErrInvalidBinding(`Cannot configure async binding for key "${keyStr(key)}":`
          + `async bindings cannot have injectable properties or injectable methods.`)
      }
    }

    const conf = { ...config, ...this.metadataReader(key) }
    const binding = newBinding(conf)
    if (config.async && !binding.scopeID) {
      binding.scopeID = Scopes.SINGLETON
    }

    const scopeID = binding.scopeID ? binding.scopeID : this.scopeID
    const ctor: Ctor | undefined
      = (binding.type as Ctor | undefined) ?? (typeof key === 'function' ? (key as Ctor) : undefined)

    if (ctor !== undefined) {
      for (const [methodName, injections] of binding.injectableMethods) {
        const method = ctor.prototype?.[methodName as string]
        if (typeof method === 'function' && method.length > injections.length) {
          throw new ErrInvalidBinding(
            `Cannot configure "${keyStr(key)}": method "${String(methodName)}" has ${method.length} parameter(s) but ${injections.length} injection key(s) were specified`,
          )
        }
      }
    }

    const scope = this.scopes.get(scopeID)
    if (scope === undefined && scopeID !== Scopes.TRANSIENT) {
      throw new ErrScopeNotRegistered(scopeID)
    }

    binding.scopeID = scopeID

    binding.lazy
      = binding.lazy === undefined && this.lazy === undefined
        ? scope?.lazy ?? true
        : binding.lazy === undefined
          ? this.lazy
          : binding.lazy

    const canonical = this.registerBinding(key, binding)

    this.mapNamed(canonical)
    this.mapLabeled(key, canonical)
    this.mapAbstract(canonical)

    if (!this._compiled && config.conditionals.length > 0) {
      this._pendingConditionalKeys.add(key)
    }
  }

  private async refresh(label?: symbol): Promise<void> {
    return (this.scopes.get(Scopes.REFRESH) as RefreshScope).refresh(label)
  }

  private unref(key: Key) {
    const binding = this.registry.get(key)
    if (binding === undefined) {
      return
    }

    for (const label of binding.labels) {
      const list = this.bindingsByLabel.get(label)
      if (list) {
        const idx = list.findIndex(([, b]) => b.id === binding.id)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
        if (list.length === 0) {
          this.bindingsByLabel.delete(label)
        }
      }
    }

    for (const name of binding.names) {
      const list = this.bindings.get(name)
      if (list) {
        const idx = list.findIndex(b => b.id === binding.id)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
        if (list.length === 0) {
          this.bindings.delete(name)
        }
      }
    }

    if (binding.extend) {
      const list = this.bindings.get(binding.extend)
      if (list) {
        const idx = list.findIndex(b => b.id === binding.id)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
        if (list.length === 0) {
          this.bindings.delete(binding.extend)
        }
      }
    }

    this.registry.delete(key)
    this.bindings.delete(key)
    this._pendingConditionalKeys.delete(key)
  }

  private async preDestroyBinding(binding: Binding): Promise<void> {
    if (binding.preDestroy === undefined) {
      return
    }

    const scope = this.scopes.get(binding.scopeID)
    if (scope === undefined) {
      if (binding.scopeID !== Scopes.TRANSIENT) {
        throw new ErrScopeNotRegistered(binding.scopeID)
      }
      return
    }

    const cached = await scope.cachedInstance<any>(binding)
    if (cached !== undefined) {
      return binding.preDestroy!(cached)
    }
  }

  private isRegistrable(binding: Binding): boolean {
    if (binding.profiles.size === 0) {
      return true
    }

    for (const p of binding.profiles) {
      if (this.profiles.has(p)) {
        return true
      }
    }

    return false
  }

  private registerBinding<T>(key: Key<T>, binding: Binding<T>): Binding<T> {
    const existing = this.registry.get(key)
    if (existing) {
      Object.assign(existing, binding, { id: existing.id })

      return existing as Binding<T>
    } else {
      this.registry.set(key, binding)
      this.bindings.set(key, [binding])

      return binding
    }
  }

  private mapLabeled(key: Key, binding: Binding): void {
    for (const label of binding.labels) {
      let list = this.bindingsByLabel.get(label)
      if (!list) {
        list = []
        this.bindingsByLabel.set(label, list)
      }

      if (!list.some(([, b]) => b.id === binding.id)) {
        list.push([key, binding])
      }
    }
  }

  private mapNamed(binding: Binding): void {
    for (const name of binding.names) {
      const list = this.bindings.get(name)
      if (!list) {
        this.bindings.set(name, [binding])
      } else {
        const idx = list.findIndex(b => b.id === binding.id)
        if (idx === -1) {
          if (binding.primary) {
            if (list.some(b => b.primary)) {
              throw new ErrMultiplePrimary(name)
            }

            list.unshift(binding)
          } else {
            list.push(binding)
          }
        } else if (binding.primary && idx > 0) {
          let hasPrimary = false

          for (let i = 0; i < idx; i++) {
            if (list[i].primary) {
              hasPrimary = true
              break
            }
          }

          if (hasPrimary) {
            throw new ErrMultiplePrimary(name)
          }

          list.splice(idx, 1)
          list.unshift(binding)
        }
      }
    }
  }

  private mapAbstract(binding: Binding): void {
    if (binding.configuration) {
      return
    }

    const base = binding.extend
    if (base === undefined) {
      return
    }

    const baseReg = this.registry.get(base)
    if (baseReg !== undefined && baseReg.type === base) {
      const childName = (binding.type as Ctor | undefined)?.name ?? String(binding.type)
      const baseName = (base as Ctor).name ?? String(base)
      throw new ErrInjectableBase(childName, baseName)
    }

    const list = this.bindings.get(base)
    if (!list) {
      this.bindings.set(base, [binding])
      return
    }

    const existingIdx = list.findIndex(b => b.id === binding.id)
    if (existingIdx === -1) {
      if (binding.primary) {
        if (list.some(b => b.primary)) {
          throw new ErrMultiplePrimary(base)
        }

        list.unshift(binding)
      } else {
        list.push(binding)
      }
    } else if (binding.primary && existingIdx > 0) {
      if (list.some((b, i) => b.primary && i !== existingIdx)) {
        throw new ErrMultiplePrimary(base)
      }

      list.splice(existingIdx, 1)
      list.unshift(binding)
    }
  }

  /**
   * Compiles all registered bindings — runs module evaluation, conditional resolution,
   * circular-reference checks, scope validation, and factory compilation.
   *
   * May be called before {@link init} to pre-warm the container (e.g. for benchmarking).
   * Calling {@link init} after `compile()` will skip recompilation automatically.
   * Subsequent calls are no-ops.
   */
  async compile(): Promise<void> {
    if (this._compiled) {
      return
    }
    await Promise.all(this.modules.map((module, index) => runModule(module, this, index)))
    await this.evaluatePendingConditionals()

    if (this.circularReferences) {
      checkCircularReferences(this.registry, this.bindings)
    }

    checkScopes(
      { mode: this.scopeCheckMode, scopes: this.scopes, getBindings: this.getBindings.bind(this) },
      this.registry.entries(),
    )

    checkAspects(this.registry.entries())

    const hasAspects = this.bindingsByLabel.has(kAspectLabel)
    if (hasAspects) {
      const aopInterceptors = buildAOPInterceptors(this)
      for (const [key, binding] of this.registry.entries()) {
        const ctor = binding.type ?? (typeof key === 'function' ? key as Function : null)
        if (ctor) {
          const interceptor = aopInterceptors.get(ctor)
          if (interceptor) {
            binding.interceptors.unshift(interceptor)
          }
        }
      }
    }

    this._aspectScopeCache = this.computeAspectScopeCache()

    for (const [key, binding] of this.registry.entries()) {
      compileInjectionResolvers(this, key, binding)
      compileFactory(this, this.scopes, key, binding)
    }

    this._compiled = true
  }

  private async resolveAsyncBinding(key: Key, binding: Binding): Promise<void> {
    const scope = this.scopes.get(binding.scopeID) as SingletonScope
    await (binding.unscopedFactory({ container: this, key, binding }) as Promise<unknown>)
      .then(instance => {
        scope.set(binding, instance)
        this.hooks.emit('onBindingInitialized', { key, binding, instance, async: true })
      })
      .catch(error => {
        this.hooks.emit('onBindingInitializationFailed', { key, binding, error, async: true })
        throw error
      })
  }

  private async resolveAsyncBindings(): Promise<void> {
    for (const [key, binding] of this._sortedAsyncEntries) {
      const scope = this.scopes.get(binding.scopeID) as SingletonScope
      if (scope.cachedInstance(binding) != null) {
        continue
      }
      await this.resolveAsyncBinding(key, binding)
    }
  }

  /**
   * Returns async bindings sorted in dependency order using topological sort.
   * Dependencies are derived from constructor injections only — property and method injections
   * are excluded because they are not supported on async bindings.
   */
  private sortAsyncBindings(): [Key, Binding][] {
    const asyncEntries = [...this.registry.entries()].filter(([, b]) => b.async)
    if (asyncEntries.length < 2) {
      return asyncEntries
    }

    const asyncKeySet = new Set<Key>(asyncEntries.map(([k]) => k))
    const adjList = new Map<Key, Key[]>()
    const inDegree = new Map<Key, number>()

    for (const [key] of asyncEntries) {
      adjList.set(key, [])
      inDegree.set(key, 0)
    }

    for (const [key, binding] of asyncEntries) {
      const depKeys = new Set<Key>(
        [
          ...binding.injections.map(d => d.key as Key),
        ].filter(k => asyncKeySet.has(k)),
      )

      for (const dep of depKeys) {
        adjList.get(dep)!.push(key)
        inDegree.set(key, inDegree.get(key)! + 1)
      }
    }

    const aspectQueue: Key[] = []
    const otherQueue: Key[] = []
    for (const [key, deg] of inDegree) {
      if (deg === 0) {
        if (this.registry.get(key)?.labels.includes(kAspectLabel)) {
          aspectQueue.push(key)
        } else {
          otherQueue.push(key)
        }
      }
    }
    const queue: Key[] = [...aspectQueue, ...otherQueue]

    const result: [Key, Binding][] = []
    while (queue.length > 0) {
      const key = queue.shift()!
      result.push([key, this.registry.get(key)!])
      for (const dependent of adjList.get(key)!) {
        const newDeg = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDeg)
        if (newDeg === 0) {
          if (this.registry.get(dependent)?.labels.includes(kAspectLabel)) {
            queue.unshift(dependent)
          } else {
            queue.push(dependent)
          }
        }
      }
    }

    return result.length === asyncEntries.length ? result : asyncEntries
  }

  private findPendingConfigForKey(key: Key): Key | undefined {
    for (const [configKey, providedKeys] of this._pendingConfigKeys) {
      if (providedKeys.includes(key)) {
        return configKey
      }
    }

    return undefined
  }

  private async evaluatePendingConditionals(): Promise<void> {
    const justRegistered = new Set<number>()

    const evalAll = async (conditionals: Conditional[], ctx: ConditionContext): Promise<boolean> => {
      for (const c of conditionals) {
        if (!await c(ctx)) {
          return false
        }
      }
      return true
    }

    const registerEntry = (key: Key, binding: Binding): void => {
      this.configureBinding(key, binding)
      justRegistered.add(this.registry.get(key)!.id)
    }

    for (const entry of this._pendingConditionals) {
      if (!entry.binding.configuration || entry.fallback || entry.providedByConfig !== undefined) {
        continue
      }

      const ctx: ConditionContext = { container: this, key: entry.key, binding: entry.binding }
      const pass = await evalAll(entry.binding.conditionals, ctx)

      if (pass) {
        registerEntry(entry.key, entry.binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding: entry.binding })

        for (const provided of this._pendingConditionals) {
          if (provided.providedByConfig !== entry.key || provided.fallback) {
            continue
          }

          const pCtx: ConditionContext = { container: this, key: provided.key, binding: provided.binding }
          const pPass = await evalAll(provided.binding.conditionals, pCtx)

          if (pPass) {
            registerEntry(provided.key, provided.binding)
            this.hooks.emit('onBindingRegistered', { key: provided.key, binding: provided.binding })
          } else {
            this.hooks.emit('onBindingNotRegistered', { key: provided.key, binding: provided.binding })
          }
        }
      } else {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding: entry.binding })

        for (const provided of this._pendingConditionals) {
          if (provided.providedByConfig === entry.key) {
            this.hooks.emit('onBindingNotRegistered', { key: provided.key, binding: provided.binding })
          }
        }
      }
    }

    for (const entry of this._pendingConditionals) {
      if (entry.binding.configuration || entry.fallback || entry.providedByConfig !== undefined) {
        continue
      }

      const ctx: ConditionContext = { container: this, key: entry.key, binding: entry.binding }
      const pass = await evalAll(entry.binding.conditionals, ctx)

      if (pass) {
        registerEntry(entry.key, entry.binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding: entry.binding })
      } else {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding: entry.binding })
      }
    }

    for (const entry of this._pendingConditionals) {
      if (!entry.fallback || entry.providedByConfig !== undefined) {
        continue
      }

      if (this.registry.has(entry.key) || !this.isRegistrable(entry.binding)) {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding: entry.binding })
        continue
      }

      const ctx: ConditionContext = { container: this, key: entry.key, binding: entry.binding }
      const pass = await evalAll(entry.binding.conditionals, ctx)

      if (pass) {
        registerEntry(entry.key, entry.binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding: entry.binding })
      } else {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding: entry.binding })
      }
    }

    const toUnref: Key[] = []
    for (const [key, binding] of this.registry) {
      if (binding.conditionals.length > 0 && !justRegistered.has(binding.id)) {
        const ctx: ConditionContext = {
          container: this,
          key,
          binding: binding as unknown as Binding,
        }
        const pass = await evalAll(binding.conditionals, ctx)
        if (!pass) {
          toUnref.push(key)
        }
      }
    }

    for (const key of toUnref) {
      const binding = this.registry.get(key)!
      this.unref(key)
      this.hooks.emit('onBindingNotRegistered', { key, binding: binding as unknown as Binding })
    }

    this._pendingConditionals = []
    this._pendingConfigKeys.clear()
    this._pendingConditionalKeys.clear()
  }

  private walkScopeGraph(visited: Set<number>, queue: Binding[], scopeID: Identifier): boolean {
    while (queue.length > 0) {
      const binding = queue.shift()!
      if (visited.has(binding.id)) {
        continue
      }

      visited.add(binding.id)

      if (binding.scopeID === scopeID) {
        return true
      }

      const injKeys: (Key | undefined)[] = [
        ...binding.injections.map(i => i.key),
        ...[...binding.injectableProperties.values()].map(i => i.key),
        ...[...binding.injectableMethods.values()].flatMap(list => list.map(i => i.key)),
      ]

      for (const injKey of injKeys) {
        if (injKey != null && this.has(injKey)) {
          for (const dep of this.getBindings(injKey)) {
            if (!visited.has(dep.id)) {
              queue.push(dep)
            }
          }
        }
      }
    }

    return false
  }

  private computeAspectScopeCache(): Set<Identifier> {
    const scopes = new Set<Identifier>()
    const aspects = this.bindingsByLabel.get(kAspectLabel) ?? []
    if (aspects.length === 0) {
      return scopes
    }

    const queue: Binding[] = aspects.map(([, b]) => b)
    const collect = (visited: Set<number>, q: Binding[]): void => {
      while (q.length > 0) {
        const binding = q.shift()!
        if (visited.has(binding.id)) {
          continue
        }

        visited.add(binding.id)
        scopes.add(binding.scopeID)

        const injKeys: (Key | undefined)[] = [
          ...binding.injections.map(i => i.key),
          ...[...binding.injectableProperties.values()].map(i => i.key),
          ...[...binding.injectableMethods.values()].flatMap(list => list.map(i => i.key)),
        ]

        for (const injKey of injKeys) {
          if (injKey != null && this.has(injKey)) {
            for (const dep of this.getBindings(injKey)) {
              if (!visited.has(dep.id)) {
                q.push(dep)
              }
            }
          }
        }
      }
    }

    collect(new Set(), queue)

    return scopes
  }
}

export function newContainer(...modules: Module[]): CaffeineIoC
export function newContainer(options: Partial<Options>, ...modules: Module[]): CaffeineIoC
export function newContainer(
  optionsOrModuleFn: Partial<Options> | Module = {},
  ...modules: Module[]
): CaffeineIoC {
  const isModuleFn = typeof optionsOrModuleFn === 'function'
  const allModuleFns = isModuleFn ? [optionsOrModuleFn, ...modules] : modules

  return new CaffeineIoC(isModuleFn ? {} : optionsOrModuleFn, ...allModuleFns)
}
