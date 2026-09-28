import './_polyfill.js'
import { checkCircularReferences, checkIfContainerIsResolvable, checkAspects } from './_checks.js'
import { compileDescriptorResolver, compileFactory, compileInjectionResolvers } from './_compile.js'
import { buildAOPInterceptors, kAspectLabel, type MethodAspect } from './aop.js'
import { AspectSpec } from './aspect_spec.js'
import { newBinding, Binding } from './binding.js'
import { BindingSpec, kBuildBinding } from './binding_spec.js'
import { Conditional, ConditionContext } from './conditional.js'
import { BindingDescriptor, Container, Options, ScopeCheckMode } from './container_interface.js'
import { decoratedBindings, getBindingConfiguration, decoratorConfigToBinding } from './decorators/registrar/index.js'
import {
  ErrRepeatedInjectableConfiguration,
  ErrNoUniqueInjectionForKey,
  ErrNoResolutionForKey,
  ErrInvalidBinding,
  ErrScopeNotRegistered,
  ErrMultiplePrimary,
  ErrInvalidContainerState,
  ErrInjectableBase,
  ErrNoValuesProvider,
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
import type { OnBootstrap, OnDestroy } from './lifecycle.js'
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

// How a binding reached the container: made by hand with bind() or aspect(), restored from a snapshot, or wired by
// autoWire() from a decorated type.
type BoundBy = 'bind' | 'restore' | 'wire'

interface HeldBinding {
  key: InjectionToken
  binding: Binding
  by: BoundBy
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
  private readonly _bootstrapBindings = new Map<InjectionToken, Binding>()

  private readonly bindingMembers = new Map<InjectionToken | Identifier, Set<number>>()
  private readonly labelMembers = new Map<symbol, Set<number>>()
  private readonly lazy?: boolean
  private readonly circularReferences: boolean
  private readonly scopeID: NamedToken<Scope>
  private readonly scopes: Map<NamedToken<Scope>, Scope>
  private readonly scopeCheckMode: ScopeCheckMode

  readonly postProcessors: Set<PostProcessor> = new Set()
  readonly hooks: HookListener = new HookListener()
  readonly refresher!: Refresher
  readonly requestScopeManager!: RequestScopeManager

  private readonly _profiles: Set<string>
  private _ready = false
  private _initializing = false
  private _compiled = false
  private _held: HeldBinding[] = []
  private _sortedAsyncEntries: [InjectionToken, Binding][] = []
  private _aspectScopeCache: Set<NamedToken<Scope>> | null = null
  private _hasRequestScoped = false
  private _hasAsync = false
  private _values: unknown

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

    this._profiles = new Set(opts.profiles ?? [])
    this.lazy = opts.lazy
    this.circularReferences = opts.checks?.circularReferences ?? true
    this.scopeCheckMode = opts.checks?.scopes ?? 'compatible-scopes-only'
    this.scopeID = opts.defaultScopeID ?? Scopes.SINGLETON
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
  get profiles(): ReadonlySet<string> {
    return this._profiles
  }

  /**
   * Whether the container has at least one request scoped component.
   */
  get hasRequestScope(): boolean {
    return this._hasRequestScoped
  }

  /**
   * The values bound with {@link bindConfig}, which `$i.config` injections read.
   *
   * @throws {@link ErrNoValuesProvider} if {@link bindConfig} was never called
   */
  get values(): unknown {
    if (this._values === undefined) {
      throw new ErrNoValuesProvider()
    }

    return this._values
  }

  /**
   * Whether {@link bindConfig} was called, so that reading {@link values} does not throw.
   */
  get hasValues(): boolean {
    return this._values !== undefined
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
   * name it aliases, or by a subclass bound with `.extends(key)`.
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
    const spec = new BindingSpec<TokenValue<K>, K>(key as InjectionToken<TokenValue<K>>, binding)

    configure(spec)

    this.registerOrHold(key as InjectionToken, spec[kBuildBinding]())

    return this
  }

  /**
   * Sets the values that `$i.config` injections read, usually the application's configuration.
   *
   * The container holds the object itself, not a copy and not a binding: an injection reads it when its consumer is
   * built, so a change made to it in place reaches every consumer built afterwards. Calling it again before the
   * container compiles replaces the values.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already been compiled, because its `$i.config`
   * injections already hold the values
   *
   * @example
   * ```ts
   * di.bindConfig<AppConfig>({ database: { host: 'localhost', port: 5432 } })
   * ```
   */
  bindConfig<T = unknown>(values: T): this {
    notNil(values, 'Parameter values must not be null or undefined')

    if (this._ready || this._compiled) {
      throw new ErrInvalidContainerState('Cannot bind values: container has already been compiled')
    }

    this._values = values

    return this
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

    // Rebinding replaces everything that answers to the key, not only the binding registered under it: a binding
    // named after the key or extending it would otherwise stay a candidate beside the replacement. Those bindings
    // stay registered under their own keys.
    this.bindings.delete(key)
    this.bindingMembers.delete(key)

    this._held = this._held.filter(e => e.key !== key)

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

    this.registerOrHold(cls as InjectionToken, spec[kBuildBinding]())

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
   * A binding none of whose profiles was active when it was made waits for {@link compile} / {@link init}, so a
   * profile added before then still admits it.
   *
   * @param profile - The first profile to activate.
   * @param profiles - Additional profiles to activate.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already been compiled
   */
  addProfiles(profile: string, ...profiles: string[]): void {
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
   * Captures a snapshot of all non-internal bindings in their current state, and of the values bound with
   * {@link bindConfig}.
   * Works at any point — pre-init or post-init.
   * For testing purposes.
   */
  snapshot(): Snapshot {
    const entries: [InjectionToken, Binding][] = []
    // A binding made by hand and still held back belongs to the state as much as a registered one; restore() holds it
    // back again when it carries conditions. A decorated one stays out: restore() would skip its profile check, and a
    // container with decorators wires it itself.
    const held = this._held.filter(e => e.by !== 'wire').map(e => [e.key, e.binding] as const)

    for (const [key, binding] of [...this.registry, ...held]) {
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
        },
      ])
    }

    return new Snapshot(entries, this._values)
  }

  /**
   * Restores bindings from the given snapshot into the container, and the values when the snapshot carries any.
   * Must be called before {@link init}.
   */
  restore(snap: Snapshot): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot restore: container is already initialized')
    }

    for (const [key, binding] of snap.entries()) {
      this.registerOrHold(key, binding, 'restore')
    }

    if (snap.values !== undefined) {
      this._values = snap.values
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
   * Hands every decorated class and `@Provides` method to the container, as {@link bind} hands a binding made by
   * hand, and emits `onDecoratedBindingWired` for each. One with conditions, or none of whose profiles is active yet,
   * waits for {@link compile}. Called by the constructor unless the `decorators` option is `false`.
   *
   * @throws {@link ErrInvalidContainerState} if the container is already initialized
   * @throws {@link ErrOrphanedBindingConfig} if a class carries binding decorators but was never made injectable
   */
  autoWire(): void {
    if (this._ready) {
      throw new ErrInvalidContainerState('Cannot register binding: container is already initialized')
    }

    for (const [key, binding] of decoratedBindings()) {
      this.hooks.emit('onDecoratedBindingWired', { key, binding })
      this.registerOrHold(key, binding, 'wire')
    }
  }

  /**
   * Initializes the container.
   * It compiles the bindings and prepares them for resolution, so it must be called before the container
   * can be used for resolution. Once every binding is resolved, runs every registered bootstrap hook (an
   * `OnBootstrap` class, `@OnLifecycle({ bootstrap })`, or `.bootstrap()`) in dependency order, forcing
   * resolution of any lazy singleton binding that registered one.
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

      for (const [, binding] of this.sortBootstrapBindings()) {
        const instance = binding.factory(binding.ctx!)
        await binding.bootstrap!(instance)
      }

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
      `${this.constructor.name}(profiles=[${[...this.profiles].join(', ')}], count=${this.size}) {` +
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
  private configureBinding<T>(key: InjectionToken<T>, config: Binding<T>): void {
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

      if ((config.injectableProperties?.size ?? 0) > 0) {
        throw new ErrInvalidBinding(
          `Cannot configure async binding for key "${keyStr(key)}":` +
            `async bindings cannot have injectable properties.`,
        )
      }
    }

    const binding = newBinding<T>(config)
    if (config.async && !binding.scopeID) {
      binding.scopeID = Scopes.SINGLETON
    }

    const scopeID = binding.scopeID ? binding.scopeID : this.scopeID
    const ctor: Ctor | undefined =
      (binding.type as Ctor | undefined) ?? (typeof key === 'function' ? (key as Ctor) : undefined)

    if (ctor !== undefined) {
      // A class binding opts into container lifecycle by implementing OnBootstrap / OnDestroy. An explicit
      // hook set on the spec (or an @OnLifecycle callback) still wins.
      if (binding.bootstrap === undefined && typeof ctor.prototype?.onBootstrap === 'function') {
        binding.bootstrap = (instance: T) => (instance as OnBootstrap).onBootstrap()
      }
      if (binding.preDestroy === undefined && typeof ctor.prototype?.onDestroy === 'function') {
        binding.preDestroy = (instance: T) => (instance as OnDestroy).onDestroy()
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

    if (canonical.scopeID === Scopes.REQUEST) {
      this._hasRequestScoped = true
    }

    if (canonical.async) {
      this._hasAsync = true
    }

    if (canonical.bootstrap !== undefined) {
      if (canonical.scopeID !== Scopes.SINGLETON) {
        throw new ErrInvalidBinding(
          `Cannot configure binding "${keyStr(key)}": bootstrap hooks are only allowed on singleton-scoped bindings`,
        )
      }

      this._bootstrapBindings.set(key, canonical)
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

    // Only this binding leaves the list under its key: a binding named after the key or extending it still
    // answers to it.
    this.unmapMemberships(binding)
    this.unmapFrom(key, binding)

    this.registry.delete(key)
    this._bootstrapBindings.delete(key)
  }

  /**
   * Takes the binding out of every list it joined through its names, labels and base.
   */
  private unmapMemberships(binding: Binding): void {
    for (const label of binding.labels) {
      this.releaseMember(this.labelMembers, label, binding.id)

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
      this.unmapFrom(name, binding)
    }

    if (binding.extend) {
      this.unmapFrom(binding.extend, binding)
    }
  }

  private unmapFrom(key: InjectionToken | Identifier, binding: Binding): void {
    this.releaseMember(this.bindingMembers, key, binding.id)

    const list = this.bindings.get(key)
    if (list === undefined) {
      return
    }

    const idx = list.findIndex(b => b.id === binding.id)
    if (idx !== -1) {
      list.splice(idx, 1)
    }
    if (list.length === 0) {
      this.bindings.delete(key)
    }
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

  private matchesProfiles(profiles: Set<string> | undefined): boolean {
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

  private registerBinding<T>(key: InjectionToken<T>, binding: Binding<T>): Binding<T> {
    const existing = this.registry.get(key)
    if (existing) {
      // Registering a key again replaces its configuration, so the names, labels, base and bootstrap hook of the
      // old one must stop pointing at it. configureBinding maps the new ones afterwards.
      this.unmapMemberships(existing)
      this._bootstrapBindings.delete(key)

      Object.assign(existing, binding, { id: existing.id })
      this.mapUnder(key, existing)

      return existing as Binding<T>
    }

    this.registry.set(key, binding)
    // Joins the bindings already answering to the key through a name or a base rather than replacing them, so the
    // order they were registered in does not decide what the key resolves to.
    this.mapUnder(key, binding)

    return binding
  }

  /**
   * Records that `id` now sits in the list under `key`, and reports whether it was absent before.
   *
   * False means the binding is already mapped there and the caller must not add it again.
   */
  private claimMember<K>(index: Map<K, Set<number>>, key: K, id: number): boolean {
    const ids = index.get(key)
    if (ids === undefined) {
      index.set(key, new Set([id]))
      return true
    }

    if (ids.has(id)) {
      return false
    }

    ids.add(id)

    return true
  }

  private releaseMember<K>(index: Map<K, Set<number>>, key: K, id: number): void {
    const ids = index.get(key)
    if (ids === undefined) {
      return
    }

    ids.delete(id)

    if (ids.size === 0) {
      index.delete(key)
    }
  }

  private mapLabeled(key: InjectionToken, binding: Binding): void {
    for (const label of binding.labels) {
      if (!this.claimMember(this.labelMembers, label, binding.id)) {
        continue
      }

      const list = this.bindingsByLabel.get(label)
      if (list === undefined) {
        this.bindingsByLabel.set(label, [[key, binding]])
      } else {
        list.push([key, binding])
      }
    }
  }

  private mapNamed(binding: Binding): void {
    for (const name of binding.names) {
      this.mapUnder(name, binding)
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

    this.mapUnder(base, binding)
  }

  /**
   * Adds the binding to the list of bindings that answer to `key`, keeping a primary first.
   *
   * The list is shared by the binding registered under `key`, the bindings named `key` and the bindings extending
   * it, whatever order they were registered in.
   */
  private mapUnder(key: InjectionToken | Identifier, binding: Binding): void {
    const list = this.bindings.get(key)
    if (!list) {
      this.claimMember(this.bindingMembers, key, binding.id)
      this.bindings.set(key, [binding])
      return
    }

    if (this.claimMember(this.bindingMembers, key, binding.id)) {
      if (binding.primary) {
        if (list.some(b => b.primary)) {
          throw new ErrMultiplePrimary(key)
        }

        list.unshift(binding)
      } else {
        list.push(binding)
      }

      return
    }

    // Already mapped. Only a primary can still need to move, so the index is worth locating only then.
    if (!binding.primary) {
      return
    }

    const idx = list.findIndex(b => b.id === binding.id)
    if (idx > 0) {
      if (list.some((b, i) => b.primary && i !== idx)) {
        throw new ErrMultiplePrimary(key)
      }

      list.splice(idx, 1)
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
    await this.decideHeld()

    if (this.circularReferences) {
      checkCircularReferences(this.registry, this.bindings)
    }

    checkScopes(
      { mode: this.scopeCheckMode, scopes: this.scopes, getBindings: this.getBindings.bind(this) },
      this.registry.entries(),
    )

    const aspects = this.bindingsByLabel.get(kAspectLabel)

    checkAspects(aspects ?? [])

    if (aspects !== undefined) {
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
   * Dependencies are derived from constructor injections only — property injections
   * are excluded because they are not supported on async bindings.
   */
  private sortAsyncBindings(): [InjectionToken, Binding][] {
    if (!this._hasAsync) {
      return []
    }

    const asyncEntries = [...this.registry.entries()].filter(([, b]) => b.async)
    return this.topoSortEntries(asyncEntries, kAspectLabel)
  }

  private sortBootstrapBindings(): [InjectionToken, Binding][] {
    if (this._bootstrapBindings.size === 0) {
      return []
    }

    return this.topoSortEntries([...this._bootstrapBindings.entries()])
  }

  /**
   * Topologically sorts `entries` by constructor-injection dependencies (Kahn's algorithm), considering an
   * edge only between two entries both present in `entries` — a dependency on a binding outside the set has
   * nothing to order against. `priorityLabel`, when given, moves zero-indegree bindings carrying that label
   * to the front of the ready queue at every step.
   *
   * Falls back to `entries` unsorted if a cycle prevents a full ordering, so a cyclic subset degrades
   * gracefully instead of throwing.
   */
  private topoSortEntries(entries: [InjectionToken, Binding][], priorityLabel?: symbol): [InjectionToken, Binding][] {
    if (entries.length < 2) {
      return entries
    }

    const keySet = new Set<InjectionToken>(entries.map(([k]) => k))
    const adjList = new Map<InjectionToken, InjectionToken[]>()
    const inDegree = new Map<InjectionToken, number>()

    for (const [key] of entries) {
      adjList.set(key, [])
      inDegree.set(key, 0)
    }

    for (const [key, binding] of entries) {
      const depKeys = new Set<InjectionToken>(
        [...binding.injections.map(d => d.key as InjectionToken)].filter(k => keySet.has(k)),
      )

      for (const dep of depKeys) {
        adjList.get(dep)!.push(key)
        inDegree.set(key, inDegree.get(key)! + 1)
      }
    }

    const priorityQueue: InjectionToken[] = []
    const otherQueue: InjectionToken[] = []
    for (const [key, deg] of inDegree) {
      if (deg === 0) {
        if (priorityLabel !== undefined && this.registry.get(key)?.labels.includes(priorityLabel)) {
          priorityQueue.push(key)
        } else {
          otherQueue.push(key)
        }
      }
    }
    const queue: InjectionToken[] = [...priorityQueue, ...otherQueue]

    const result: [InjectionToken, Binding][] = []
    while (queue.length > 0) {
      const key = queue.shift()!
      result.push([key, this.registry.get(key)!])
      for (const dependent of adjList.get(key)!) {
        const newDeg = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDeg)
        if (newDeg === 0) {
          if (priorityLabel !== undefined && this.registry.get(dependent)?.labels.includes(priorityLabel)) {
            queue.unshift(dependent)
          } else {
            queue.push(dependent)
          }
        }
      }
    }

    return result.length === entries.length ? result : entries
  }

  /**
   * Registers a binding, or holds it back until {@link compile} while it cannot be decided yet: it carries conditions,
   * none of its profiles is active, or it is a `@Provides` whose `@Configuration` class is held back.
   *
   * Held back, its conditions never see the binding itself, and a binding already registered under its key stays until
   * it is admitted. A default bound with `.conditional(ctx => !ctx.container.has(key))` relies on both. Binding the key
   * again by hand discards it, the way it would replace a registered binding. A wired one is never discarded: two
   * `@Provides` of one key may be alternatives a profile or a condition chooses between.
   */
  private registerOrHold(key: InjectionToken, binding: Binding, by: BoundBy = 'bind'): void {
    if (by !== 'wire') {
      const held = this._held.findIndex(e => e.by !== 'wire' && e.key === key)
      if (held !== -1) {
        this._held.splice(held, 1)
      }
    }

    // Profiles are only ever added, so one that matches now still matches at compile(). A restored binding was matched
    // against the profiles of the container it came from.
    const source = binding.source?.ctor
    if (
      binding.conditionals.length > 0 ||
      (by !== 'restore' && !this.matchesProfiles(binding.profiles)) ||
      (source !== undefined && this._held.some(e => e.key === source))
    ) {
      this._held.push({ key, binding, by })
      return
    }

    this.register(key, binding, by)
  }

  private register(key: InjectionToken, binding: Binding, by: BoundBy): void {
    // A @Provides never replaces what is registered under its key: two of one key would replace each other silently
    // unless a condition chooses between them. A snapshot carries the @Provides it was taken with.
    if (by !== 'restore' && binding.configuredBy !== undefined && this.registry.has(key)) {
      throw new ErrRepeatedInjectableConfiguration(
        `Found multiple bindings with the same injection key "${keyStr(key)}" configured at "${binding.configuredBy}"`,
      )
    }

    this.configureBinding(key, binding)
  }

  private async evalConditionals(conditionals: Conditional[], ctx: ConditionContext): Promise<boolean> {
    for (const c of conditionals) {
      if (!(await c(ctx))) {
        return false
      }
    }

    return true
  }

  /**
   * Decides the bindings held back until now.
   *
   * Those without conditions go first, so every condition sees what the active profiles admit. Those with conditions
   * follow one at a time: the decorated `@Configuration` classes and `@Provides` first, then the rest, each in the
   * order it was held. A `@Configuration` class with conditions takes the `@Provides` held back with it along: they are
   * decided right after it, and none of their own conditions runs when it is left out.
   */
  private async decideHeld(): Promise<void> {
    const held = this._held
    this._held = []

    const followers = new Map<InjectionToken, HeldBinding[]>()
    for (const { key, binding } of held) {
      if (binding.configuration && binding.source === undefined && binding.conditionals.length > 0) {
        followers.set(key, [])
      }
    }

    const conditional: HeldBinding[] = []
    for (const entry of held) {
      const { key, binding, by } = entry
      const follows = binding.source === undefined ? undefined : followers.get(binding.source.ctor)

      if (follows !== undefined) {
        follows.push(entry)
      } else if (binding.conditionals.length > 0) {
        conditional.push(entry)
      } else if (this.admits(entry)) {
        this.register(key, binding, by)
        this.hooks.emit('onBindingRegistered', { key, binding })
      } else {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
      }
    }

    const first = (e: HeldBinding): boolean => e.by === 'wire' && e.binding.configuration === true

    for (const entry of [...conditional.filter(first), ...conditional.filter(e => !first(e))]) {
      await this.decide(entry)

      // Taken out once decided, so a class held twice does not decide its @Provides twice.
      const follows = entry.binding.source === undefined ? followers.get(entry.key) : undefined
      if (follows !== undefined) {
        followers.delete(entry.key)

        for (const provided of follows) {
          await this.decide(provided)
        }
      }
    }
  }

  // Not through register(): a binding its conditions admit replaces the one registered under its key, as a conditional
  // bind() does.
  private async decide(entry: HeldBinding): Promise<void> {
    const { key, binding } = entry
    const pass =
      this.admits(entry) && (await this.evalConditionals(binding.conditionals, { container: this, key, binding }))

    if (!pass) {
      this.hooks.emit('onBindingNotRegistered', { key, binding })
      return
    }

    this.configureBinding(key, binding)
    this.hooks.emit('onBindingRegistered', { key, binding })
  }

  // A restored binding was matched against the profiles of the container it came from. A @Provides whose @Configuration
  // class was left out has no instance to call.
  private admits({ binding, by }: HeldBinding): boolean {
    return (
      (by === 'restore' || this.matchesProfiles(binding.profiles)) &&
      (binding.source === undefined || this.has(binding.source.ctor))
    )
  }

  // The queue is consumed with a cursor rather than `shift()`, which is O(n) per dequeue, and dependencies are
  // walked in place rather than gathered into a fresh array per node.
  private walkScopeGraph(visited: Set<number>, queue: Binding[], scopeID: NamedToken<Scope>): boolean {
    for (let i = 0; i < queue.length; i++) {
      const binding = queue[i]
      if (visited.has(binding.id)) {
        continue
      }

      visited.add(binding.id)

      if (binding.scopeID === scopeID) {
        return true
      }

      this.enqueueDependencies(binding, visited, queue)
    }

    return false
  }

  private enqueueDependencies(binding: Binding, visited: Set<number>, queue: Binding[]): void {
    const push = (injKey: InjectionToken | undefined): void => {
      if (injKey == null) {
        return
      }

      const deps = this.getBindings(injKey)
      for (let i = 0; i < deps.length; i++) {
        if (!visited.has(deps[i].id)) {
          queue.push(deps[i])
        }
      }
    }

    for (let i = 0; i < binding.injections.length; i++) {
      push(binding.injections[i].key as InjectionToken | undefined)
    }

    for (const injection of binding.injectableProperties.values()) {
      push(injection.key as InjectionToken | undefined)
    }
  }

  private computeAspectScopeCache(): Set<NamedToken<Scope>> {
    const scopes = new Set<NamedToken<Scope>>()
    const aspects = this.bindingsByLabel.get(kAspectLabel) ?? []
    if (aspects.length === 0) {
      return scopes
    }

    const queue: Binding[] = aspects.map(([, b]) => b)
    const visited = new Set<number>()

    for (let i = 0; i < queue.length; i++) {
      const binding = queue[i]
      if (visited.has(binding.id)) {
        continue
      }

      visited.add(binding.id)
      scopes.add(binding.scopeID)

      this.enqueueDependencies(binding, visited, queue)
    }

    return scopes
  }
}

export function newContainer(options: Partial<Options> = {}): CaffeineIoC {
  return new CaffeineIoC(options)
}
