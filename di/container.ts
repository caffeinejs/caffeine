import './_polyfill.js'
import { checkCircularReferences, checkIfContainerIsResolvable, checkAspects } from './_checks.js'
import { compileDescriptorResolver, compileFactory, compileInjectionResolvers } from './_compile.js'
import { buildAOPInterceptors, kAspectLabel, type MethodAspect } from './aop.js'
import { AspectSpec } from './aspect_spec.js'
import { newBinding, Binding, configurationOf } from './binding.js'
import { BindingSpec, kBuildBinding } from './binding_spec.js'
import { decideConditions, detachFrom, type ConditionOps, type HeldBinding } from './conditional.js'
import {
  BindingDescriptor,
  Container,
  ContainerOverride,
  Options,
  OverrideOps,
  ScopeCheckMode,
} from './container_interface.js'
import { getBindingConfigurations, providedBindingConfigurations, hasInjectable } from './decorators/registrar/index.js'
import {
  ErrDuplicateBinding,
  ErrNoUniqueInjectionForKey,
  ErrNoResolutionForKey,
  ErrInvalidBinding,
  ErrScopeNotRegistered,
  ErrOrphanedBindingConfig,
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
import { type Annotation, isAnnotated } from './reflect.js'
import { Refresher } from './refresher.js'
import { RequestScopeManager } from './request_scope_manager.js'
import { Scopes, scopeEntries, Scope, ScopedInstance } from './scope.js'
import { Declaration, Snapshot } from './snapshot.js'
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
  private readonly modules: Array<Module | ModuleFn>
  private readonly declared: Declaration[] = []
  // The declarations the constructor made, first in `declared`: the container's own bindings. A snapshot leaves them
  // out, since the container it is restored into makes its own.
  private readonly ownDeclarations: number
  private readonly overriders: ContainerOverride[] = []
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
  private _decorators: boolean
  private _ready = false
  private _initializing = false
  private _compiling = false
  private _registered = false
  // Set while held bindings are decided: what they are decided against must not change under them.
  private _deciding = false
  private _compiled = false
  private _registration: Promise<void> | undefined
  private _compilation: Promise<void> | undefined
  // Bindings carrying conditions, waiting for them to be decided. A condition never sees its own binding.
  private _held: HeldBinding[] = []
  // Bindings a profile, a condition, a rebind() or an override left out, reported once compile() is done.
  private _dropped: [InjectionToken, Binding][] = []
  private _sortedAsyncEntries: [InjectionToken, Binding][] = []
  private _aspectScopeCache: Set<NamedToken<Scope>> | null = null
  private _hasRequestScope = false
  private _hasAsync = false
  private _values: unknown
  private _scopedConfig: Provider<unknown> | undefined

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
    this._decorators = opts.decorators ?? true

    for (const [id, factory] of scopeEntries()) {
      this.scopes.set(id, factory(this))
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

    this.ownDeclarations = this.declared.length
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
    return this._hasRequestScope
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
   * The provider bound with {@link bindScopedConfig}, which `$i.liveConfig` injections read through.
   *
   * @throws {@link ErrNoValuesProvider} if {@link bindScopedConfig} was never called
   */
  get scopedConfig(): Provider<unknown> {
    if (this._scopedConfig === undefined) {
      throw new ErrNoValuesProvider(undefined, 'bindScopedConfig')
    }

    return this._scopedConfig
  }

  /**
   * Whether {@link bindScopedConfig} was called, so that reading {@link scopedConfig} does not throw.
   */
  get hasScopedConfig(): boolean {
    return this._scopedConfig !== undefined
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
   * Get all bindings whose class carries the given annotation, on the class or on any member.
   *
   * The annotation's `inherit` rule decides whether a declaration on a base class counts. Like every
   * lookup, this finds nothing before the container compiles.
   */
  getBindingsByAnnotation(annotation: symbol | Annotation<unknown, never>): BindingDescriptor[] {
    return this.getBindingsBy(({ binding }) => binding.type !== undefined && isAnnotated(binding.type, annotation))
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
   * The binding is registered when the container compiles, not when `bind()` returns: until then {@link has},
   * {@link getBindings} and {@link entries} do not see it, and an invalid binding is reported by {@link compile}. A key
   * takes one binding, so binding a key that ends up with another binding, decorated or bound, fails the compilation.
   * Use {@link rebind} to replace one.
   *
   * Decorators are not read: a decorated class bound here gets only what its binding declares.
   *
   * @param key - The key to bind the type to.
   * @param configure - Describes the binding on the {@link BindingSpec} it receives.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already registered its bindings: {@link compile},
   * {@link init} or {@link assertResolvable} has run
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

    this.assertNotRegistered('Cannot bind')

    const spec = new BindingSpec<TokenValue<K>, K>(key as InjectionToken<TokenValue<K>>, newBinding<TokenValue<K>>())

    configure(spec)

    this.declare(key as InjectionToken, spec[kBuildBinding](), false)

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
    this.assertNotDeciding('Cannot bind values')

    if (this._ready || this._compiled) {
      throw new ErrInvalidContainerState('Cannot bind values: container has already been compiled')
    }

    this._values = values

    return this
  }

  /**
   * Binds the provider `$i.liveConfig` injections read through. Unlike {@link bindConfig}, whose values a consumer
   * reads once when it is built, the provider is asked on every `get()` of the injected {@link Provider}, so a
   * consumer built once still reads what the provider answers now.
   *
   * @example
   * ```ts
   * di.bindScopedConfig<AppConfig>({ get: () => store.current })
   * ```
   */
  bindScopedConfig<T = unknown>(provider: Provider<T>): this {
    notNil(provider, 'Parameter provider must not be null or undefined')
    this.assertNotDeciding('Cannot bind the scoped config')

    if (this._ready || this._compiled) {
      throw new ErrInvalidContainerState('Cannot bind the scoped config: container has already been compiled')
    }

    this._scopedConfig = provider

    return this
  }

  /**
   * Replaces whatever answers to the given key with a new binding: the binding registered under it, however it was
   * made, and the bindings answering to it through a name or a base, which stay registered under their own keys.
   *
   * It is the one way to replace a binding. Called before the container compiles, the replacement is applied once
   * the decorated bindings, the ones bound by hand and the modules' are registered, so it replaces any of them. A key
   * with no binding is simply bound.
   *
   * @param key - The key to rebind.
   * @param configure - Describes the replacement binding on the {@link BindingSpec} it receives.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already registered its bindings: {@link compile},
   * {@link init} or {@link assertResolvable} has run
   */
  rebind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this {
    notNil(key)

    this.assertNotRegistered('Cannot rebind')

    const spec = new BindingSpec<TokenValue<K>, K>(key as InjectionToken<TokenValue<K>>, newBinding<TokenValue<K>>())

    configure(spec)

    this.declare(key as InjectionToken, spec[kBuildBinding](), true)

    return this
  }

  /**
   * Registers an AOP {@link MethodAspect}.
   *
   * @param cls - The aspect class to register. Must implement {@link MethodAspect}.
   *
   * @throws {@link ErrInvalidContainerState} if the container has already registered its bindings: {@link compile},
   * {@link init} or {@link assertResolvable} has run
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

    this.assertNotRegistered('Cannot bind aspect')

    const binding = newBinding<InstanceType<C>>({ type: cls, labels: [kAspectLabel] })
    const spec = new AspectSpec<InstanceType<C>, C>(cls as unknown as InjectionToken<InstanceType<C>>, binding)

    configure(spec)

    this.declare(cls as InjectionToken, spec[kBuildBinding](), false)

    return this
  }

  /**
   * Adds new {@link Module}s to the container.
   * Modules will be applied during {@link init}.
   *
   * @param module - The module to add.
   * @param rest - Additional modules to add.
   *
   * @throws {@link ErrInvalidContainerState} if the container has started compiling
   */
  addModules(module: Module | ModuleFn, ...rest: Array<Module | ModuleFn>): void {
    this.assertOpen('Cannot add modules')

    this.modules.push(module, ...rest)
  }

  /**
   * Adds profiles to the container's active set.
   * Every binding is matched against them when the container compiles, however it was made.
   *
   * @param profile - The first profile to activate.
   * @param profiles - Additional profiles to activate.
   *
   * @throws {@link ErrInvalidContainerState} if the container has started compiling
   */
  addProfiles(profile: string, ...profiles: string[]): void {
    this.assertOpen('Cannot add profiles')

    notNil(profile, `Parameter profile must not be null or undefined`)

    this._profiles.add(profile)
    for (const p of profiles) {
      this._profiles.add(p)
    }
  }

  /**
   * Adds a step that changes the bindings once every one is registered and its profiles and conditions are decided,
   * and before any is resolved. Overrides run in the order they were added, when the container compiles.
   *
   * A binding an override adds is decided right after it: its profiles and conditions apply as to any other.
   *
   * @throws {@link ErrInvalidContainerState} if the container has started compiling
   *
   * @example
   * ```ts
   * container.overrides(ops => {
   *   ops.unbind(MailSender)
   *   ops.rebind(Clock, t => t.toValue(fixedClock))
   * })
   * ```
   */
  overrides(override: ContainerOverride): this {
    notNil(override)

    this.assertOpen('Cannot add overrides')

    this.overriders.push(override)

    return this
  }

  /**
   * Captures what the container was told to hold: the bindings declared with {@link bind}, {@link rebind} and
   * {@link aspect}, its modules, its profiles, whether it registers decorated bindings, the values bound with
   * {@link bindConfig} and the provider bound with {@link bindScopedConfig}. The container's own bindings
   * (`Keys.kRefresher`, `Keys.kRequestScopeManager`) are left out: every container binds its own.
   *
   * Restored with {@link restore}, it gives the same bindings whether it was taken before or after {@link init}.
   * For testing purposes.
   */
  snapshot(): Snapshot {
    const declarations: Declaration[] = []
    for (const { key, binding, rebind } of this.declared.slice(this.ownDeclarations)) {
      declarations.push({ key, binding: copyBinding(binding), rebind })
    }

    return new Snapshot({
      declarations,
      modules: [...this.modules],
      profiles: [...this._profiles],
      decorators: this._decorators,
      values: this._values,
      scopedConfig: this._scopedConfig,
    })
  }

  /**
   * Adds what the snapshot holds to the container: its declarations, after the ones already made, its modules, its
   * profiles, and its values and its scoped config when it carries them. The container registers decorated bindings
   * when the snapshot's container did.
   *
   * @throws {@link ErrInvalidContainerState} if the container has started compiling
   */
  restore(snap: Snapshot): void {
    this.assertOpen('Cannot restore')

    for (const { key, binding, rebind } of snap.declarations()) {
      this.declared.push({ key, binding: copyBinding(binding), rebind })
    }

    this.modules.push(...snap.modules)

    for (const profile of snap.profiles) {
      this._profiles.add(profile)
    }

    this._decorators = snap.decorators

    if (snap.values !== undefined) {
      this._values = snap.values
    }

    if (snap.scopedConfig !== undefined) {
      this._scopedConfig = snap.scopedConfig
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
   * Asserts that all bindings are resolvable, reporting every missing dependency at once.
   *
   * Registers the bindings first, as {@link compile} does, without compiling them: call it before {@link init}.
   * Once it has run, the container takes no more bindings.
   *
   * @throws {@link ErrUnresolvableDependencies} if any binding is not resolvable
   */
  async assertResolvable(): Promise<void> {
    await this.registerAll()

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
   * Configures a binding for the given key and registers it.
   *
   * @param key - The key to configure the binding for.
   * @param config - The binding configuration.
   */
  private configureBinding<T>(key: InjectionToken<T>, config: Binding<T>): void {
    notNil(key)
    notNil(config)

    if (this.registry.has(key)) {
      throw new ErrDuplicateBinding(key)
    }

    if (config.async) {
      assertAsyncBinding(key, config)
    }

    // A copy, so that nothing done to the registered binding reaches the declared one a snapshot is taken from.
    const binding = copyBinding(config)
    if (config.async && !binding.scopeID) {
      binding.scopeID = Scopes.SINGLETON
    }

    const scopeID = binding.scopeID ? binding.scopeID : this.scopeID

    adoptLifecycleHooks(key, binding)

    const scope = this.scopes.get(scopeID)
    if (scope === undefined && scopeID !== Scopes.TRANSIENT) {
      throw new ErrScopeNotRegistered(scopeID)
    }

    binding.scopeID = scopeID
    binding.lazy = binding.lazy ?? this.lazy ?? scope?.lazy ?? true

    this.registry.set(key, binding)
    // Joins the bindings already answering to the key through a name or a base rather than replacing them, so the
    // order they were registered in does not decide what the key resolves to.
    this.mapUnder(key, binding)

    this.mapNamed(binding)
    this.mapLabeled(key, binding)
    this.mapAbstract(binding)

    if (binding.scopeID === Scopes.REQUEST) {
      this._hasRequestScope = true
    }

    if (binding.async) {
      this._hasAsync = true
    }

    if (binding.bootstrap !== undefined) {
      if (binding.scopeID !== Scopes.SINGLETON) {
        throw new ErrInvalidBinding(
          `Cannot configure binding "${keyStr(key)}": bootstrap hooks are only allowed on singleton-scoped bindings`,
        )
      }

      this._bootstrapBindings.set(key, binding)
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
   * Registers every binding and prepares it for resolution.
   *
   * In order: registers the decorated bindings when the `decorators` option is on, then the bindings declared with
   * {@link bind} and {@link aspect}, runs the modules, applies the {@link rebind} calls, decides the conditions, runs
   * the {@link overrides}, and then checks the graph and compiles the factories. Profiles are matched as each binding
   * is registered. A key takes one binding.
   *
   * May be called before {@link init} to pre-warm the container (e.g. for benchmarking).
   * Calling {@link init} after `compile()` will skip recompilation automatically.
   * Subsequent calls return the same compilation, including its failure.
   *
   * @throws {@link ErrDuplicateBinding} if a key ends up with more than one binding
   */
  compile(): Promise<void> {
    this._compilation ??= this.compileOnce()

    return this._compilation
  }

  private async compileOnce(): Promise<void> {
    await this.registerAll()

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

    this._compiling = false
    this._compiled = true
  }

  /**
   * Registers every binding and decides its profiles, conditions and overrides, once.
   */
  private registerAll(): Promise<void> {
    this._registration ??= this.registerOnce()

    return this._registration
  }

  private async registerOnce(): Promise<void> {
    this._compiling = true

    if (this._decorators) {
      this.autoWire()
    }

    const rebinds: Declaration[] = []
    for (const declaration of this.declared) {
      if (declaration.rebind) {
        rebinds.push(declaration)
      } else {
        this.register(declaration.key, declaration.binding)
      }
    }

    await runModules(this.modules, this)

    for (const { key, binding } of rebinds) {
      this.replace(key, binding)
    }

    this.decideConditions()

    if (this.overriders.length > 0) {
      const ops = this.overrideOps()
      for (const override of this.overriders) {
        await override(ops)
        this.decideConditions()
      }
    }

    // Modules and overrides have bound what they bind. A binding declared from here on would miss the conditions,
    // the overrides and the hooks, so there is none, not even from a listener of the hooks below.
    this._registered = true

    for (const [key, binding] of this.registry) {
      this.hooks.emit('onBindingRegistered', { key, binding })
    }
    for (const [key, binding] of this._dropped) {
      this.hooks.emit('onBindingNotRegistered', { key, binding })
    }
    this._dropped = []
  }

  /**
   * Registers the decorated bindings, with the same {@link register} every other binding goes through.
   */
  private autoWire(): void {
    for (const [key, config] of getBindingConfigurations()) {
      if (!hasInjectable(key)) {
        throw new ErrOrphanedBindingConfig(key)
      }

      const binding = config.binding()

      this.hooks.emit('onDecoratedBinding', { key, binding })
      this.register(key, binding)
    }

    for (const [key, config] of providedBindingConfigurations()) {
      const binding = config.binding()

      this.hooks.emit('onDecoratedBinding', { key, binding })
      this.register(key, binding)
    }
  }

  /**
   * Keeps a binding declared before the container compiles, or registers it right away while it compiles: in a
   * module or an override.
   */
  private declare(key: InjectionToken, binding: Binding, rebind: boolean): void {
    if (!this._compiling) {
      this.declared.push({ key, binding, rebind })
      return
    }

    if (rebind) {
      this.replace(key, binding)
    } else {
      this.register(key, binding)
    }
  }

  /**
   * Registers a binding, however it was made. Profiles are final once the container compiles, so a binding whose
   * profiles do not match is dropped here. One carrying conditions, or provided by a configuration class that
   * carries them, is held until {@link decideConditions}.
   *
   * @throws {@link ErrDuplicateBinding} if a binding is already registered under the key
   */
  private register(key: InjectionToken, binding: Binding): void {
    const parent = configurationOf(binding)

    if (!this.matchesProfiles(binding.profiles) || (parent !== undefined && this.isDropped(parent))) {
      this._dropped.push([key, binding])
      return
    }

    if (binding.conditions.length > 0 || (parent !== undefined && this.isHeld(parent))) {
      this._held.push({ key, binding })
      return
    }

    this.configureBinding(key, binding)
  }

  /**
   * Replaces whatever answers to the key, registered or held, with the given binding.
   */
  private replace(key: InjectionToken, binding: Binding): void {
    this.unbind(key)

    const held = this._held
    this._held = []
    for (const entry of held) {
      if (entry.key === key) {
        this._dropped.push([entry.key, entry.binding])
      } else {
        this._held.push(detachFrom(entry, key))
      }
    }

    // Rebinding replaces everything that answers to the key, not only the binding registered under it: a binding
    // named after the key or extending it would otherwise stay a candidate beside the replacement. Those bindings
    // stay registered under their own keys.
    this.bindings.delete(key)
    this.bindingMembers.delete(key)

    this.register(key, binding)
  }

  private unbind(key: InjectionToken): void {
    const binding = this.registry.get(key)
    if (binding === undefined) {
      return
    }

    this.unref(key)
    this._dropped.push([key, binding])
  }

  private isHeld(key: InjectionToken): boolean {
    return this._held.some(entry => entry.key === key)
  }

  private isDropped(key: InjectionToken): boolean {
    return !this.registry.has(key) && !this.isHeld(key)
  }

  /**
   * Decides the held bindings, with the rules in `conditional.ts`.
   */
  private decideConditions(): void {
    const held = this._held
    if (held.length === 0) {
      return
    }

    this._held = []

    this._deciding = true
    try {
      decideConditions(held, this.conditionOps())
    } finally {
      this._deciding = false
    }
  }

  private conditionOps(): ConditionOps {
    return {
      has: key => this.has(key),
      isRegistered: key => this.registry.has(key),
      hasValues: () => this.hasValues,
      values: () => this.values,
      register: (key, binding) => this.configureBinding(key, binding),
      drop: (key, binding) => {
        this._dropped.push([key, binding])
      },
    }
  }

  private overrideOps(): OverrideOps {
    return {
      entries: () => this.entries(),
      getBindings: key => this.getBindings(key),
      has: key => this.has(key),
      bind: (key, configure) => {
        this.bind(key, configure)
      },
      rebind: (key, configure) => {
        this.rebind(key, configure)
      },
      unbind: key => this.unbind(key),
    }
  }

  private assertOpen(action: string): void {
    if (this._compiling || this._compiled || this._ready) {
      throw new ErrInvalidContainerState(`${action}: container has already started compiling`)
    }
  }

  private assertNotRegistered(action: string): void {
    this.assertNotDeciding(action)

    if (this._registered || this._compiled || this._ready) {
      throw new ErrInvalidContainerState(`${action}: container has already registered its bindings`)
    }
  }

  private assertNotDeciding(action: string): void {
    if (this._deciding) {
      throw new ErrInvalidContainerState(`${action}: the container is deciding conditions`)
    }
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

/**
 * Refuses what an async binding cannot be: lazy, scoped other than singleton or refresh, or property injected.
 */
function assertAsyncBinding(key: InjectionToken, config: Binding): void {
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
      `Cannot configure async binding for key "${keyStr(key)}":` + `async bindings cannot have injectable properties.`,
    )
  }
}

/**
 * A class binding opts into container lifecycle by implementing OnBootstrap / OnDestroy. An explicit hook set on the
 * spec (or an @OnLifecycle callback) still wins.
 */
function adoptLifecycleHooks<T>(key: InjectionToken<T>, binding: Binding<T>): void {
  const ctor: Ctor | undefined =
    (binding.type as Ctor | undefined) ?? (typeof key === 'function' ? (key as Ctor) : undefined)
  if (ctor === undefined) {
    return
  }

  if (binding.bootstrap === undefined && typeof ctor.prototype?.onBootstrap === 'function') {
    binding.bootstrap = (instance: T) => (instance as OnBootstrap).onBootstrap()
  }
  if (binding.preDestroy === undefined && typeof ctor.prototype?.onDestroy === 'function') {
    binding.preDestroy = (instance: T) => (instance as OnDestroy).onDestroy()
  }
}

/**
 * Copies the binding along with its collections, which the container changes in place once it registers one.
 */
function copyBinding<T>(binding: Binding<T>): Binding<T> {
  return newBinding<T>({
    ...binding,
    injections: [...binding.injections],
    injectableProperties: new Map(binding.injectableProperties),
    interceptors: [...binding.interceptors],
    profiles: new Set(binding.profiles),
    names: [...binding.names],
    conditions: [...binding.conditions],
    keysProvided: [...binding.keysProvided],
    labels: [...binding.labels],
    tags: new Map(binding.tags),
    injectionResolvers: [],
    propertyResolvers: new Map(),
  })
}
