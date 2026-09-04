import './_polyfill.js'
import { checkCircularReferences, checkIfContainerIsResolvable, checkAspects } from './_checks.js'
import { compileDescriptorResolver, compileFactory, compileInjectionResolvers } from './_compile.js'
import { buildAOPInterceptors, kAspectLabel, type MethodAspect } from './aop.js'
import { AspectSpec } from './aspect_spec.js'
import { newBinding, Binding } from './binding.js'
import { BindingSpec, kBuildBinding } from './binding_spec.js'
import { Conditional, ConditionContext } from './conditional.js'
import { BindingDescriptor, Container, Options, ScopeCheckMode } from './container_interface.js'
import {
  getBindingConfigurations,
  getBindingConfiguration,
  providedBindingConfigurations,
  hasInjectable,
  decoratorConfigToBinding,
} from './decorators/registrar/index.js'
import type { DecoratedBindingConfig } from './decorators/registrar/spec.js'
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
import { HookListener } from './hooks.js'
import { Injection, InjectionDescriptor, ResolveInjection } from './injection.js'
import { builtInStages } from './injection_builtin_stages.js'
import { InjectionResolver, registerStage } from './injection_resolver.js'
import { SingletonScope, RefreshScope, RequestScope } from './internal/core/scope/index.js'
import { checkScopes } from './internal/core/scope/validations.js'
import { notNil } from './internal/util/assert/index.js'
import { isConstructable } from './internal/util/clazz/clazz.js'
import { keyStr, InjectionToken, Identifier, NamedToken, TokenValue } from './key.js'
import { MetadataReader } from './metadata_reader.js'
import { runModules, type Module, type ModuleFn } from './module.js'
import { PostProcessor } from './post_processor.js'
import { Provider } from './provider.js'
import { Refresher } from './refresher.js'
import { RequestScopeManager } from './request_scope_manager.js'
import { Scopes, scopeEntries, Scope, ScopedInstance } from './scope.js'
import { Snapshot } from './snapshot.js'
import { Keys } from './symbols.js'
import { Ctor } from './types.js'

// Wiring the built-ins is a real dependency rather than a module side effect, so nothing here reads as removable.
// Module scope runs once, which is what makes registerStage's duplicate-name throw a non-issue.
for (const [name, middleware, options] of builtInStages) {
  registerStage(name, middleware, options)
}

const DEFAULT_OPTIONS: Partial<Options> = {
  defaultScopeID: Scopes.SINGLETON,
  lazy: false,
  decorators: true,
  checks: {
    circularReferences: true,
    scopes: 'compatible-scopes-only',
  },
}

interface PendingBinding {
  key: InjectionToken
  config?: DecoratedBindingConfig
  binding?: Binding
  fallback: boolean
  providedByConfig?: InjectionToken
  profileRejected?: boolean
}

/**
 * CaffeineIoC IoC container implementation of the {@link Container} interface.
 * A container must always be initialized before it can be used.
 * Upon initialization, it is no longer possible to register new bindings.
 *
 * @sealed
 */
export class CaffeineIoC implements Container {
  private readonly modules: Array<Module | ModuleFn>
  private readonly registry = new Map<InjectionToken, Binding>()
  private readonly bindings = new Map<InjectionToken | Identifier, Binding[]>()
  private readonly bindingsByLabel = new Map<symbol, [InjectionToken, Binding][]>()
  private readonly metadataReader: MetadataReader
  private readonly lazy?: boolean
  private readonly circularReferences: boolean
  private readonly scopeID: NamedToken<Scope>
  private readonly scopes: Map<NamedToken<Scope>, Scope>
  private readonly scopeCheckMode: ScopeCheckMode

  readonly postProcessors: Set<PostProcessor> = new Set()
  readonly hooks: HookListener = new HookListener()
  readonly parent?: Container
  readonly refresher!: Refresher
  readonly requestScopeManager!: RequestScopeManager

  private readonly _profiles: Set<Identifier>
  private _ready = false
  private _initializing = false
  private _compiled = false
  private _pendingConditionals: PendingBinding[] = []
  private _pendingProfiles: PendingBinding[] = []
  private _pendingManualProfiles: PendingBinding[] = []
  private _pendingManualProfileKeys = new Set<InjectionToken>()
  private _pendingConfigKeys: Map<InjectionToken, InjectionToken[]> = new Map()
  private _pendingFallbacks: Array<[InjectionToken, Binding]> = []
  private _evaluatingProfiles = false
  private _pendingConditionalKeys = new Set<InjectionToken>()
  private _sortedAsyncEntries: [InjectionToken, Binding][] = []
  private _aspectScopeCache: Set<NamedToken<Scope>> | null = null
  private _hasRequestScoped = false

  /**
   * Creates a new container instance.
   *
   * @param options - The options to configure the container.
   */
  constructor(options: Partial<Options> = {}) {
    const opts = {
      ...DEFAULT_OPTIONS,
      ...options,
      checks: { ...DEFAULT_OPTIONS.checks, ...options.checks },
    } as Options

    this.parent = opts.parent
    this._profiles = new Set(opts.profiles ?? [])
    this.lazy = opts.lazy
    this.circularReferences = opts.checks?.circularReferences ?? true
    this.scopeCheckMode = opts.checks?.scopes ?? 'compatible-scopes-only'
    this.scopeID = opts.defaultScopeID ?? Scopes.SINGLETON
    this.metadataReader = opts.metadataReader || (() => ({}))
    this.scopes = new Map<NamedToken<Scope>, Scope>()
    this.modules = [...(opts.modules ?? [])]

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
      this.bind(Keys.kRefresher, t => t.toValue(refresher).byPassPostProcessors().internal())
    }

    if (this.scopes.has(Scopes.REQUEST)) {
      const requestScope = this.scopes.get(Scopes.REQUEST) as RequestScope
      const requestScopeManager: RequestScopeManager = {
        run: requestScope.run.bind(requestScope),
        setStorage: requestScope.setStorage.bind(requestScope),
      }

      this.requestScopeManager = requestScopeManager
      this.bind(Keys.kRequestScopeManager, t => t.toValue(requestScopeManager).byPassPostProcessors().internal())
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
   * Active profiles. Bindings restricted with `@Profile` or `.profiles()` are
   * only registered when one of their profiles is in this set.
   */
  get profiles(): ReadonlySet<Identifier> {
    return this._profiles
  }

  /**
   * Whether the container has at least one request scoped component.
   */
  get hasRequestScoped(): boolean {
    return this._hasRequestScoped
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
  get<T>(key: InjectionToken<T>): T {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot resolve: container has not been initialized — call init() first')
    }

    const resolvedKey = key
    const bindings = this.getBindings<T>(resolvedKey)
    if (bindings.length === 0) {
      throw new ErrNoResolutionForKey(`Cannot resolve key '${keyStr(resolvedKey)}'`)
    }

    const b = bindings[0]
    if (bindings.length > 1) {
      if (b.primary) {
        return b.factory(b.ctx!) as T
      }

      throw new ErrNoUniqueInjectionForKey(resolvedKey)
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
  getOptional<T = unknown>(key: InjectionToken<T>): T | undefined {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState('Cannot resolve: container has not been initialized — call init() first')
    }

    const resolvedKey = key
    const bindings = this.getBindings<T>(resolvedKey)
    if (bindings.length === 0) {
      return undefined as T
    }

    const b = bindings[0]
    if (bindings.length > 1) {
      if (b.primary) {
        return b.factory(b.ctx!) as T
      }

      throw new ErrNoUniqueInjectionForKey(resolvedKey)
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
  getMany<T>(key: InjectionToken<T>): T[] {
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
  getManyOptional<T>(key: InjectionToken<T>): T[] {
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
  wrap<T = unknown>(key: InjectionToken<T>): Provider<T> {
    const binding = this.getBinding(key)
    if (binding === undefined) {
      throw new ErrNoResolutionForKey(
        `Cannot wrap key "${keyStr(key)}": no binding registered for key "${keyStr(key)}"`,
      )
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
  wrapMany<T = unknown>(key: InjectionToken<T>): Provider<T[]> {
    const bindings = this.getBindings<T>(key)
    if (bindings.length === 0) {
      throw new ErrNoResolutionForKey(
        `Cannot wrap key "${keyStr(key)}": no binding registered for key "${keyStr(key)}"`,
      )
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
  getBinding<T = unknown>(key: InjectionToken<T>): Binding<T> {
    const bindings = this.getBindings<T>(key)

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
  getBindings<T = unknown>(key: InjectionToken<T>): Binding<T>[] {
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
   * Checks whether the given key can be resolved: by a binding registered under it, by one bound under a
   * name it aliases, or by a subclass bound with `.extends(key)`. Falls through to the parent container.
   *
   * True exactly when {@link get} would resolve, so a key that resolves is never reported absent. Whether a
   * binding is registered *directly* under the key is a different question this does not answer.
   */
  has<T>(key: InjectionToken<T>): boolean {
    return this.getBindings(key).length > 0
  }

  /**
   * Checks if the given key has the given scope within its dependency graph.
   *
   * @param key - The key to check for.
   * @param scopeID - The scope to check for.
   *
   * @returns True if the key or any of its underlying dependencies have the given scope.
   */
  hasScopeInGraph(key: InjectionToken, scopeID: NamedToken<Scope>): boolean {
    if (!this.has(key)) {
      return false
    }

    if (this._aspectScopeCache !== null && this._aspectScopeCache.has(scopeID)) {
      return true
    }

    // A copy: the walk consumes its queue with `shift()`, and `getBindings` hands back the container's own
    // array — walking it directly leaves the key with no bindings at all.
    return this.walkScopeGraph(new Set(), [...this.getBindings(key)], scopeID)
  }

  /**
   * Compiles an injection into a function that resolves it, honouring the binding's scope on every call.
   *
   * This is the same compilation an `@Injectable` constructor parameter goes through, exposed for callers that
   * hold an injection as data rather than as a decorated dependency — a route declaring what its handler needs,
   * for one. Compile once, call per use: a singleton returns the cached instance, a transient a new one, and a
   * request-scoped binding the instance of the scope that is live at call time.
   *
   * @param injection - The key or descriptor to resolve. Any `$i` helper is accepted.
   *
   * @example
   * ```ts
   * const deps = container.resolver($i.object({ svc: PetService, audit: $i.optional(Audit) }))
   *
   * deps() // { svc: PetService, audit: Audit | undefined }
   * ```
   */
  resolver<I extends Injection>(injection: I): () => ResolveInjection<I> {
    if (!this._ready && !this._initializing) {
      throw new ErrInvalidContainerState(
        'Cannot compile resolver: container has not been initialized — call init() first',
      )
    }

    const descriptor: InjectionDescriptor =
      typeof injection === 'object' ? (injection as InjectionDescriptor) : { key: injection }

    // There is no consumer: the injection stands on its own rather than being a component's dependency. The
    // placeholder key says so, and keeps the "do not inject a component into itself" filter — which reads the
    // consumer's own bindings — from matching anything.
    return compileDescriptorResolver(
      this,
      Keys.kStandaloneResolver,
      descriptor,
      'constructor',
      '',
      -1,
    ) as () => ResolveInjection<I>
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
      return () => (isClazz ? new ctor() : (ctor() as T))
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

      resolvers[i] = compileDescriptorResolver(this, injection.key as InjectionToken, injection, 'constructor', '', i)
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
   * @param configure - Describes the binding on the {@link BindingSpec} it receives.
   *
   * @example
   * ```ts
   * container
   *   .bind(Repository, t => t.toSelf())
   *   .bind(kPort, t => t.toValue(8080))
   * ```
   */
  bind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this {
    notNil(key)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot bind: container is already initialized — call init() first')
    }

    const type = getBindingConfiguration(key)
    const binding = newBinding<TokenValue<K>>(type ? decoratorConfigToBinding(type) : {})

    // Binding a key by hand is an explicit registration, so `@Fallback` on the decorated class is not
    // inherited — otherwise an override would defer to the very default it is replacing. Only an explicit
    // `.fallback()` on the spec holds the binding back.
    binding.fallback = undefined

    const spec = new BindingSpec<TokenValue<K>, K>(key as InjectionToken<TokenValue<K>>, binding)

    configure(spec)

    this.registerOrDeferFallback(key as InjectionToken, spec[kBuildBinding]())

    return this
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
   * di.bindValuesProvider<AppConfig>(t => t.toValue(configHandle))
   * di.bindValuesProvider<AppConfig>(t => t.toClass(MyConfigProvider).lifetime(Scopes.SINGLETON))
   * ```
   */
  bindValuesProvider<T = unknown>(configure: (spec: BindingSpec<T>) => void): this {
    return this.bind(
      Keys.kValuesProvider as InjectionToken<T>,
      configure as unknown as (spec: BindingSpec<unknown, InjectionToken<T>>) => void,
    )
  }

  /**
   * Rebinds the given key with a new binding.
   * The existing binding for the given key will be unregistered.
   * For testing purposes.
   *
   * @param key - The key to rebind.
   * @param configure - Describes the replacement binding on the {@link BindingSpec} it receives.
   */
  rebind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this {
    notNil(key)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot rebind: container is already initialized — call init() first')
    }

    if (this.registry.has(key)) {
      this.unref(key)
    }

    this._pendingConditionals = this._pendingConditionals.filter(e => e.key !== key)
    this._pendingProfiles = this._pendingProfiles.filter(e => e.key !== key)
    this._pendingManualProfiles = this._pendingManualProfiles.filter(e => e.key !== key)
    this._pendingManualProfileKeys.delete(key)
    this._pendingConfigKeys.delete(key)
    this._pendingFallbacks = this._pendingFallbacks.filter(([k]) => k !== key)

    return this.bind(key, configure)
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
   *   .aspect(LoggingAspect, t => t
   *     .toSelf()
   *     .pointcuts($aop.forClass(UserService, 'findUser')))
   *   .aspect(MetricsAspect, t => t
   *     .toAsyncFactory(async () => new MetricsAspect(await buildClient()))
   *     .pointcuts($aop.forClass(OrderService, $aop.matchMethodPattern(/^find/))))
   * ```
   */
  aspect<C extends Ctor<MethodAspect<any>>>(cls: C, configure: (spec: AspectSpec<InstanceType<C>, C>) => void): this {
    notNil(cls)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot bind: container is already initialized — call init() first')
    }

    const binding = newBinding<InstanceType<C>>({ type: cls, labels: [kAspectLabel] })
    const spec = new AspectSpec<InstanceType<C>, C>(cls as unknown as InjectionToken<InstanceType<C>>, binding)

    configure(spec)

    this.registerOrDeferFallback(cls as InjectionToken, spec[kBuildBinding]())

    return this
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
  addModules(module: Module | ModuleFn, ...rest: Array<Module | ModuleFn>): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot add modules once the container has been initialized')
    }

    this.modules.push(module, ...rest)
  }

  /**
   * Adds profiles to the container's active set.
   * Profile matching runs during {@link compile} / {@link init}.
   *
   * @param profile - The first profile to activate.
   * @param profiles - Additional profiles to activate.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already been compiled
   */
  addProfiles(profile: Identifier, ...profiles: Identifier[]): void {
    if (this._ready || this._compiled) {
      throw new ErrInvalidContainerState('Cannot add profiles once the container has been compiled')
    }

    notNil(profile, `Parameter profile must not be null or undefined`)

    this._profiles.add(profile)
    for (const p of profiles) {
      this._profiles.add(p)
    }
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
    const entries: [InjectionToken, Binding][] = []

    for (const [key, binding] of this.registry) {
      if (binding.internal) {
        continue
      }

      const isDerived =
        typeof key === 'function' ||
        binding.type !== undefined ||
        binding.factoryCreator !== undefined ||
        binding.source !== undefined

      entries.push([
        key,
        {
          ...binding,
          factory: isDerived ? undefined! : (binding.unscopedFactory ?? binding.factory),
          unscopedFactory: undefined!,
          ctx: undefined,
          injectionResolvers: [],
          propertyResolvers: new Map(),
          methodResolvers: new Map(),
        },
      ])
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
      this.configureBinding(key, binding, false)
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
  async resetInstance(key: InjectionToken): Promise<void> {
    notNil(key)

    const bindings = this.getBindings(key)
    const asyncBindings = bindings.filter(b => b.async)

    if (asyncBindings.length === 0) {
      await Promise.all(
        bindings.map((b: Binding) => this.preDestroyBinding(b).finally(() => this.scopes.get(b.scopeID)?.reset(b))),
      )

      return
    }

    const asyncIds = new Set(asyncBindings.map(b => b.id))
    for (const [k, b] of this._sortedAsyncEntries.filter(([, b]) => asyncIds.has(b.id))) {
      await this.preDestroyBinding(b).finally(() => this.resolveAsyncBinding(k, b))
    }

    await Promise.all(
      bindings
        .filter(b => !b.async)
        .map((b: Binding) => this.preDestroyBinding(b).finally(() => this.scopes.get(b.scopeID)?.reset(b))),
    )

    return
  }

  /**
   * Resets the instance bound to the given binding.
   * If the binding is async, the instance will be automatically re-initialized.
   */
  async resetBinding(binding: Binding): Promise<void> {
    if (binding.async) {
      return this.preDestroyBinding(binding).finally(() => this.resolveAsyncBinding(binding.ctx!.key, binding))
    }

    return this.preDestroyBinding(binding).finally(() => this.scopes.get(binding.scopeID)?.reset(binding))
  }

  /**
   * Registers decorated bindings into the container.
   * autoWire() is called automatically when the container is created if `decorators` option is true (default).
   */
  autoWire(): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot register binding: container is already initialized')
    }

    const pendingFallbacks: [InjectionToken, Binding][] = []
    const pendingFallbackProvided: [InjectionToken, Binding][] = []

    for (const [key, config] of getBindingConfigurations()) {
      if (!hasInjectable(key)) {
        throw new ErrOrphanedBindingConfig(key)
      }

      if (this.queueProfiledConfig(key, config)) {
        continue
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

    for (const [key, config] of providedBindingConfigurations()) {
      const configKey = this.findPendingConfigForKey(key)

      if (this.queueProfiledConfig(key, config, configKey)) {
        continue
      }

      const binding = config.binding()

      this.hooks.emit('onSetup', { key, binding })

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
   *
   * Instances are destroyed in reverse creation order, one at a time: a scope caches an instance only after
   * its factory returns, so a dependency is always created — and therefore destroyed — after whatever depends
   * on it. An instance reached through more than one binding runs one hook, the first the order reaches.
   *
   * @throws {@link AggregateError} carrying every hook that threw. Disposal still completes.
   */
  async dispose(): Promise<void> {
    const created: ScopedInstance[] = []
    for (const scope of this.scopes.values()) {
      for (const entry of scope.instances()) {
        created.push(entry)
      }
    }

    created.sort((a, b) => b.sequence - a.sequence)

    const seen = new Set<object>()
    const errors: unknown[] = []

    try {
      for (const { binding, instance } of created) {
        if (binding.preDestroy === undefined) {
          continue
        }

        // Only reference types are deduplicated: two bindings holding the number 8080 are two settings, not
        // one resource, and each keeps its hook.
        if (instance !== null && (typeof instance === 'object' || typeof instance === 'function')) {
          if (seen.has(instance as object)) {
            continue
          }

          seen.add(instance as object)
        }

        try {
          await binding.preDestroy(instance)
        } catch (error) {
          errors.push(error)
        }
      }

      for (const scope of this.scopes.values()) {
        scope.clear()
      }
    } finally {
      this._ready = false
      this.hooks.emit('onDisposed')
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} component(s) failed during disposal`)
    }
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
  entries(): IterableIterator<[InjectionToken, Binding]> {
    return this.registry.entries()
  }

  /**
   * Returns a string describing the container's bindings.
   * Useful for debugging.
   */
  toString(): string {
    return (
      `${this.constructor.name}(profiles=[${[...this.profiles].map(String).join(', ')}], count=${this.size}) {` +
      '\n' +
      Array.from(this.entries())
        .map(
          ([key, binding]) =>
            `${keyStr(key)}: ` +
            `names=[${binding.names?.map(x => keyStr(x)).join(', ')}], ` +
            `scope=${binding.scopeID.toString()}, ` +
            `injections=[${binding.injections
              ?.map(
                spec =>
                  '[' +
                  keyStr(spec.key) +
                  `: optional=${spec.optional || false}, stages=[${spec.stages?.map(s => keyStr(s.name)).join(', ') ?? ''}]]`,
              )
              .join(', ')}], ` +
            `lazy=${binding.lazy}, ` +
            `factory=${binding.factory?.constructor?.name}`,
        )
        .join('\n, ') +
      '\n}'
    )
  }

  /**
   * Disposes the container. Alias of {@link dispose} that lets a container back an
   * `await using` declaration.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  [Symbol.iterator](): IterableIterator<[InjectionToken, Binding]> {
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
  private configureBinding<T>(key: InjectionToken<T>, config: Binding<T>, queueProfileEval = true): void {
    notNil(key)
    notNil(config)

    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot register binding: container is already initialized')
    }

    if (config.async) {
      if (config.lazy) {
        throw new ErrInvalidBinding(`Cannot configure binding "${keyStr(key)}": async bindings cannot be lazy`)
      }

      const allowed =
        config.scopeID === undefined || config.scopeID === Scopes.SINGLETON || config.scopeID === Scopes.REFRESH
      if (!allowed) {
        throw new ErrInvalidBinding(
          `Cannot configure async binding "${keyStr(key)}": async bindings can only be singleton or refresh scoped`,
        )
      }

      if ((config.injectableProperties?.size ?? 0) > 0 || (config.injectableMethods?.size ?? 0) > 0) {
        throw new ErrInvalidBinding(
          `Cannot configure async binding for key "${keyStr(key)}":` +
            `async bindings cannot have injectable properties or injectable methods.`,
        )
      }
    }

    const conf = { ...config, ...this.metadataReader(key) }
    const binding = newBinding(conf)
    if (config.async && !binding.scopeID) {
      binding.scopeID = Scopes.SINGLETON
    }

    const scopeID = binding.scopeID ? binding.scopeID : this.scopeID
    const ctor: Ctor | undefined =
      (binding.type as Ctor | undefined) ?? (typeof key === 'function' ? (key as Ctor) : undefined)

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

    binding.lazy =
      binding.lazy === undefined && this.lazy === undefined
        ? (scope?.lazy ?? true)
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

    if (
      queueProfileEval &&
      !this._compiled &&
      !this._evaluatingProfiles &&
      canonical.profiles.size > 0 &&
      !this._pendingManualProfileKeys.has(key)
    ) {
      this._pendingManualProfileKeys.add(key)
      this._pendingManualProfiles.push({
        key,
        binding: canonical,
        fallback: canonical.fallback === true,
      })
    }

    if (canonical.scopeID === Scopes.REQUEST) {
      this._hasRequestScoped = true
    }
  }

  private async refresh(label?: symbol): Promise<void> {
    return (this.scopes.get(Scopes.REFRESH) as RefreshScope).refresh(label)
  }

  private unref(key: InjectionToken) {
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
    return this.matchesProfiles(binding.profiles)
  }

  private matchesProfiles(profiles: Set<Identifier> | undefined): boolean {
    if (!profiles || profiles.size === 0) {
      return true
    }

    const active = this._profiles
    if (active.size === 0) {
      return false
    }

    for (const p of profiles) {
      if (active.has(p)) {
        return true
      }
    }

    return false
  }

  private queueProfiledConfig(
    key: InjectionToken,
    config: DecoratedBindingConfig,
    providedByConfig?: InjectionToken,
  ): boolean {
    const profiles = config.getProfiles
    if (!profiles || profiles.size === 0) {
      return false
    }

    if (this.matchesProfiles(profiles)) {
      return false
    }

    const conditionals = config.getConditionals
    const hasConditionals = conditionals !== undefined && conditionals.length > 0
    const entry: PendingBinding = {
      key,
      config,
      fallback: config.isFallback === true,
      providedByConfig,
    }

    this._pendingProfiles.push(entry)

    if (hasConditionals && config.isConfiguration === true && config.getSource === undefined) {
      this._pendingConfigKeys.set(key, config.getKeysProvided ?? [])
    }

    if (hasConditionals || providedByConfig !== undefined) {
      this._pendingConditionals.push(entry)
    }

    return true
  }

  private isConfigClass(entry: PendingBinding): boolean {
    if (entry.providedByConfig !== undefined) {
      return false
    }

    if (entry.config !== undefined) {
      return entry.config.isConfiguration === true && entry.config.getSource === undefined
    }

    return entry.binding?.configuration === true && entry.binding.source === undefined
  }

  private entryMatchesProfiles(entry: PendingBinding): boolean {
    return this.matchesProfiles(entry.config?.getProfiles ?? entry.binding?.profiles)
  }

  private shouldDeferToConditionals(entry: PendingBinding): boolean {
    const conditionals = entry.config?.getConditionals ?? entry.binding?.conditionals
    return (conditionals !== undefined && conditionals.length > 0) || entry.providedByConfig !== undefined
  }

  private materializePending(entry: PendingBinding): Binding {
    if (entry.binding !== undefined) {
      return entry.binding
    }

    const binding = entry.config!.binding()
    entry.binding = binding
    return binding
  }

  private rejectProfile(entry: PendingBinding): void {
    entry.profileRejected = true
    if (entry.binding !== undefined) {
      this.unref(entry.key)
      this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding: entry.binding })
    }
  }

  private registerProfileHit(entry: PendingBinding): void {
    const binding = this.materializePending(entry)
    this.hooks.emit('onSetup', { key: entry.key, binding })

    if (binding.configuredBy !== undefined && this.registry.has(entry.key)) {
      throw new ErrRepeatedInjectableConfiguration(
        `Found multiple bindings with the same injection key "${keyStr(entry.key)}" configured at "${binding.configuredBy}"`,
      )
    }

    this.configureBinding(entry.key, binding)
    this.hooks.emit('onBindingRegistered', { key: entry.key, binding })
  }

  private leaveForConditionals(entry: PendingBinding): void {
    const binding = this.materializePending(entry)
    this.hooks.emit('onSetup', { key: entry.key, binding })
  }

  private evaluatePendingProfiles(): void {
    this._evaluatingProfiles = true

    try {
      for (const entry of this._pendingProfiles) {
        if (!this.isConfigClass(entry) || entry.fallback) {
          continue
        }

        if (!this.entryMatchesProfiles(entry)) {
          this.rejectProfile(entry)
          continue
        }

        if (this.shouldDeferToConditionals(entry)) {
          this.leaveForConditionals(entry)
          continue
        }

        this.registerProfileHit(entry)
      }

      for (const entry of this._pendingProfiles) {
        if (this.isConfigClass(entry) || entry.fallback || entry.providedByConfig !== undefined) {
          continue
        }

        if (!this.entryMatchesProfiles(entry)) {
          this.rejectProfile(entry)
          continue
        }

        if (this.shouldDeferToConditionals(entry)) {
          this.leaveForConditionals(entry)
          continue
        }

        this.registerProfileHit(entry)
      }

      for (const entry of this._pendingProfiles) {
        if (entry.providedByConfig === undefined) {
          continue
        }

        if (!this.entryMatchesProfiles(entry)) {
          this.rejectProfile(entry)
          continue
        }

        if (this.shouldDeferToConditionals(entry)) {
          this.leaveForConditionals(entry)
          continue
        }

        this.registerProfileHit(entry)
      }

      for (const entry of this._pendingProfiles) {
        if (!entry.fallback) {
          continue
        }

        if (!this.entryMatchesProfiles(entry)) {
          this.rejectProfile(entry)
          continue
        }

        if (this.shouldDeferToConditionals(entry)) {
          this.leaveForConditionals(entry)
          continue
        }

        const binding = this.materializePending(entry)
        this.hooks.emit('onSetup', { key: entry.key, binding })

        if (this.registry.has(entry.key)) {
          this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding })
          continue
        }

        this.configureBinding(entry.key, binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding })
      }

      for (const entry of this._pendingManualProfiles) {
        if (!this.matchesProfiles(entry.binding!.profiles)) {
          this.rejectProfile(entry)
        }
      }
    } finally {
      this._evaluatingProfiles = false
      this._pendingProfiles = []
      this._pendingManualProfiles = []
      this._pendingManualProfileKeys.clear()
    }
  }

  private registerBinding<T>(key: InjectionToken<T>, binding: Binding<T>): Binding<T> {
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

  private mapLabeled(key: InjectionToken, binding: Binding): void {
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

    await runModules(this.modules, this)
    this.evaluatePendingProfiles()
    await this.evaluatePendingConditionals()
    await this.evaluatePendingFallbacks()

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
        const ctor = binding.type ?? (typeof key === 'function' ? (key as Function) : null)
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

  private async resolveAsyncBinding(key: InjectionToken, binding: Binding): Promise<void> {
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
  private sortAsyncBindings(): [InjectionToken, Binding][] {
    const asyncEntries = [...this.registry.entries()].filter(([, b]) => b.async)
    if (asyncEntries.length < 2) {
      return asyncEntries
    }

    const asyncKeySet = new Set<InjectionToken>(asyncEntries.map(([k]) => k))
    const adjList = new Map<InjectionToken, InjectionToken[]>()
    const inDegree = new Map<InjectionToken, number>()

    for (const [key] of asyncEntries) {
      adjList.set(key, [])
      inDegree.set(key, 0)
    }

    for (const [key, binding] of asyncEntries) {
      const depKeys = new Set<InjectionToken>(
        [...binding.injections.map(d => d.key as InjectionToken)].filter(k => asyncKeySet.has(k)),
      )

      for (const dep of depKeys) {
        adjList.get(dep)!.push(key)
        inDegree.set(key, inDegree.get(key)! + 1)
      }
    }

    const aspectQueue: InjectionToken[] = []
    const otherQueue: InjectionToken[] = []
    for (const [key, deg] of inDegree) {
      if (deg === 0) {
        if (this.registry.get(key)?.labels.includes(kAspectLabel)) {
          aspectQueue.push(key)
        } else {
          otherQueue.push(key)
        }
      }
    }
    const queue: InjectionToken[] = [...aspectQueue, ...otherQueue]

    const result: [InjectionToken, Binding][] = []
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

  private findPendingConfigForKey(key: InjectionToken): InjectionToken | undefined {
    for (const [configKey, providedKeys] of this._pendingConfigKeys) {
      if (providedKeys.includes(key)) {
        return configKey
      }
    }

    return undefined
  }

  /**
   * Registers a binding, or holds it back when it is a fallback.
   *
   * A fallback must not overwrite a binding that already covers the key, and the binding it competes with may
   * be registered later — by a module, or by a conditional that has not been evaluated yet. Holding it until
   * {@link evaluatePendingFallbacks} is what makes the outcome independent of the order the binds happened in.
   */
  private registerOrDeferFallback(key: InjectionToken, binding: Binding): void {
    if (binding.fallback === true) {
      this._pendingFallbacks.push([key, binding])
      return
    }

    this.configureBinding(key, binding)
  }

  /**
   * Registers the held-back fallbacks whose key is still unclaimed.
   *
   * Runs after profiles and conditionals have settled, so a competing binding has either taken the key or been
   * unregistered. The first fallback for a key wins; later ones find the key taken.
   */
  private async evaluatePendingFallbacks(): Promise<void> {
    for (const [key, binding] of this._pendingFallbacks) {
      if (this.registry.has(key) || !this.isRegistrable(binding)) {
        continue
      }

      if (
        binding.conditionals.length > 0 &&
        !(await this.evalConditionals(binding.conditionals, { container: this, key, binding }))
      ) {
        continue
      }

      this.configureBinding(key, binding)
    }

    this._pendingFallbacks = []
  }

  private async evalConditionals(conditionals: Conditional[], ctx: ConditionContext): Promise<boolean> {
    for (const c of conditionals) {
      if (!(await c(ctx))) {
        return false
      }
    }

    return true
  }

  private async evaluatePendingConditionals(): Promise<void> {
    const justRegistered = new Set<number>()

    const evalAll = (conditionals: Conditional[], ctx: ConditionContext): Promise<boolean> =>
      this.evalConditionals(conditionals, ctx)

    const registerEntry = (key: InjectionToken, binding: Binding): void => {
      this.configureBinding(key, binding)
      justRegistered.add(this.registry.get(key)!.id)
    }

    for (const entry of this._pendingConditionals) {
      if (entry.profileRejected || entry.binding === undefined) {
        continue
      }

      if (!entry.binding.configuration || entry.fallback || entry.providedByConfig !== undefined) {
        continue
      }

      const binding = entry.binding
      const ctx: ConditionContext = { container: this, key: entry.key, binding }
      const pass = await evalAll(binding.conditionals, ctx)

      if (pass) {
        registerEntry(entry.key, binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding })

        for (const provided of this._pendingConditionals) {
          if (provided.profileRejected || provided.binding === undefined) {
            continue
          }

          if (provided.providedByConfig !== entry.key || provided.fallback) {
            continue
          }

          const providedBinding = provided.binding
          const pCtx: ConditionContext = { container: this, key: provided.key, binding: providedBinding }
          const pPass = await evalAll(providedBinding.conditionals, pCtx)

          if (pPass) {
            registerEntry(provided.key, providedBinding)
            this.hooks.emit('onBindingRegistered', { key: provided.key, binding: providedBinding })
          } else {
            this.hooks.emit('onBindingNotRegistered', { key: provided.key, binding: providedBinding })
          }
        }
      } else {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding })

        for (const provided of this._pendingConditionals) {
          if (provided.profileRejected || provided.binding === undefined) {
            continue
          }

          if (provided.providedByConfig === entry.key) {
            this.hooks.emit('onBindingNotRegistered', { key: provided.key, binding: provided.binding })
          }
        }
      }
    }

    for (const entry of this._pendingConditionals) {
      if (entry.profileRejected || entry.binding === undefined) {
        continue
      }

      if (entry.binding.configuration || entry.fallback || entry.providedByConfig !== undefined) {
        continue
      }

      const binding = entry.binding
      const ctx: ConditionContext = { container: this, key: entry.key, binding }
      const pass = await evalAll(binding.conditionals, ctx)

      if (pass) {
        registerEntry(entry.key, binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding })
      } else {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding })
      }
    }

    for (const entry of this._pendingConditionals) {
      if (entry.profileRejected || entry.binding === undefined) {
        continue
      }

      if (!entry.fallback || entry.providedByConfig !== undefined) {
        continue
      }

      const binding = entry.binding
      if (this.registry.has(entry.key)) {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding })
        continue
      }

      const ctx: ConditionContext = { container: this, key: entry.key, binding }
      const pass = await evalAll(binding.conditionals, ctx)

      if (pass) {
        registerEntry(entry.key, binding)
        this.hooks.emit('onBindingRegistered', { key: entry.key, binding })
      } else {
        this.hooks.emit('onBindingNotRegistered', { key: entry.key, binding })
      }
    }

    const toUnref: InjectionToken[] = []
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

  private walkScopeGraph(visited: Set<number>, queue: Binding[], scopeID: NamedToken<Scope>): boolean {
    while (queue.length > 0) {
      const binding = queue.shift()!
      if (visited.has(binding.id)) {
        continue
      }

      visited.add(binding.id)

      if (binding.scopeID === scopeID) {
        return true
      }

      const injKeys: (InjectionToken | undefined)[] = [
        ...binding.injections.map(i => i.key),
        ...[...binding.injectableProperties.values()].map(i => i.key),
        ...[...binding.injectableMethods.values()].flatMap(list => list.map(i => i.key)),
      ]

      for (const injKey of injKeys) {
        if (injKey == null) {
          continue
        }

        for (const dep of this.getBindings(injKey)) {
          if (!visited.has(dep.id)) {
            queue.push(dep)
          }
        }
      }
    }

    return false
  }

  private computeAspectScopeCache(): Set<NamedToken<Scope>> {
    const scopes = new Set<NamedToken<Scope>>()
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

        const injKeys: (InjectionToken | undefined)[] = [
          ...binding.injections.map(i => i.key),
          ...[...binding.injectableProperties.values()].map(i => i.key),
          ...[...binding.injectableMethods.values()].flatMap(list => list.map(i => i.key)),
        ]

        for (const injKey of injKeys) {
          if (injKey == null) {
            continue
          }

          for (const dep of this.getBindings(injKey)) {
            if (!visited.has(dep.id)) {
              q.push(dep)
            }
          }
        }
      }
    }

    collect(new Set(), queue)

    return scopes
  }
}

export function newContainer(options: Partial<Options> = {}): CaffeineIoC {
  return new CaffeineIoC(options)
}
