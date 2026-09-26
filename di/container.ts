import './_polyfill.js'
import { checkCircularReferences, checkIfContainerIsResolvable, checkAspects } from './_checks.js'
import { compileDescriptorResolver, compileFactory, compileInjectionResolvers } from './_compile.js'
import { buildAOPInterceptors, kAspectLabel, type MethodAspect } from './aop.js'
import { AspectSpec } from './aspect_spec.js'
import { newBinding, Binding } from './binding.js'
import { BindingSpec, kBuildBinding } from './binding_spec.js'
import type { Condition } from './conditional.js'
import { BindingDescriptor, Container, Options, ScopeCheckMode } from './container_interface.js'
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
  ErrNoConfigProvider,
} from './errors.js'
import type { Factory } from './factory.js'
import { HookListener } from './hooks.js'
import { Injection, InjectionDescriptor, ResolveInjection } from './injection.js'
import { builtInStages } from './injection_builtin_stages.js'
import { InjectionResolver, registerStage } from './injection_resolver.js'
import { configSelector } from './internal/core/resolver/stages.js'
import { SingletonScope, RefreshScope, RequestScope } from './internal/core/scope/index.js'
import { checkScopes } from './internal/core/scope/validations.js'
import { notNil } from './internal/util/assert/index.js'
import { isConstructable } from './internal/util/clazz/clazz.js'
import { solutions } from './internal/util/errutil/index.js'
import { keyStr, InjectionToken, Identifier, NamedToken, TokenValue } from './key.js'
import type { OnBootstrap, OnDestroy } from './lifecycle.js'
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
  binding: Binding
  // Made by hand — bind(), aspect(), a module or restore() — rather than read from decorators by autoWire().
  byHand: boolean
  // The held @Configuration class this @Provides binding comes from. It registers only if the class does.
  providedByConfig?: InjectionToken
}

// Marks a snapshot's copy of a binding still held back for its conditions, and whether it was made by hand. restore()
// holds a marked copy back again; an unmarked one was registered, and is restored as it is. Not enumerable, so no spread
// of the copy carries it on.
const kHeld = Symbol('@caffeinejs/di:held')

type HeldOrigin = 'by-hand' | 'decorated'

type ConfigCondition = Extract<Condition, { kind: 'config' }>

// A configuration class, as opposed to one of its @Provides bindings, which carry the class as their source.
function isConfigurationClass(binding: Binding): boolean {
  return binding.configuration === true && binding.source === undefined
}

// A binding's conditions are tested profiles first and predicates of the application's own last, so a `when` runs only
// once everything the container can check itself has passed.
function rank(condition: Condition): number {
  switch (condition.kind) {
    case 'profile':
      return 0
    case 'when':
      return 2
    default:
      return 1
  }
}

// The key a condition checks in the registry: its own for `present` / `missing`, the config provider's for `config`.
function keyChecked(condition: Condition): InjectionToken | undefined {
  switch (condition.kind) {
    case 'present':
    case 'missing':
      return condition.key
    case 'config':
      return Keys.kConfigProvider
    default:
      return undefined
  }
}

// For every key, where the held bindings answering to it are — by that key, a name or a base. A configuration binding
// has no base, as mapAbstract skips it.
function answeringIndex(entries: readonly PendingBinding[]): Map<InjectionToken | Identifier, number[]> {
  const answering = new Map<InjectionToken | Identifier, number[]>()
  const answer = (key: InjectionToken | Identifier, i: number): void => {
    const list = answering.get(key)
    if (list === undefined) {
      answering.set(key, [i])
    } else {
      list.push(i)
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const { key, binding } = entries[i]

    answer(key, i)
    for (const name of binding.names) {
      answer(name, i)
    }
    if (binding.extend !== undefined && !binding.configuration) {
      answer(binding.extend, i)
    }
  }

  return answering
}

// Where the held bindings the one at `i` waits for are: its configuration class, and every binding answering to a key
// its conditions check — never itself, and never, for a configuration class, one of its own @Provides bindings.
function waitsOf(
  entries: readonly PendingBinding[],
  i: number,
  answering: Map<InjectionToken | Identifier, number[]>,
): Set<number> {
  const entry = entries[i]
  const waits = new Set<number>(entry.providedByConfig === undefined ? [] : answering.get(entry.providedByConfig))

  for (const condition of entry.binding.conditionals) {
    const key = keyChecked(condition)
    if (key === undefined) {
      continue
    }

    for (const j of answering.get(key) ?? []) {
      if (entries[j].providedByConfig !== entry.key) {
        waits.add(j)
      }
    }
  }

  waits.delete(i)

  return waits
}

/**
 * Orders the held bindings so that each is decided after every held binding it waits for:
 *
 * - the `@Configuration` class it was declared in, when it is a `@Provides` binding;
 * - every held binding answering — by its key, a name or its base — to a key one of its `present` / `missing`
 *   conditions checks, which is the config provider's key for a `config` condition.
 *
 * A binding does not wait for itself, and a configuration class does not wait for its own `@Provides` bindings, so a
 * class whose condition checks for a key it provides is a default. Among the bindings free to go, the first declared
 * goes first; when none is — a cycle, such as two defaults of one key — so does the first declared of the rest, and
 * the others then see it.
 */
function decisionOrder(entries: readonly PendingBinding[]): PendingBinding[] {
  const answering = answeringIndex(entries)
  const waiting = new Array<number>(entries.length).fill(0)
  const dependents = entries.map((): number[] => [])

  for (let i = 0; i < entries.length; i++) {
    const waits = waitsOf(entries, i, answering)

    waiting[i] = waits.size
    for (const j of waits) {
      dependents[j].push(i)
    }
  }

  const decided = new Array<boolean>(entries.length).fill(false)
  const order: PendingBinding[] = []

  while (order.length < entries.length) {
    let next = waiting.findIndex((count, i) => count === 0 && !decided[i])
    if (next === -1) {
      next = decided.indexOf(false)
    }

    decided[next] = true
    order.push(entries[next])

    for (const d of dependents[next]) {
      waiting[d]--
    }
  }

  return order
}

// What a snapshot keeps of a binding: its configuration, without what compile() derives from it.
function snapshotCopy(key: InjectionToken, binding: Binding): Binding {
  const isDerived =
    typeof key === 'function' ||
    binding.type !== undefined ||
    binding.factoryCreator !== undefined ||
    binding.source !== undefined

  return {
    ...binding,
    factory: isDerived ? undefined! : (binding.unscopedFactory ?? binding.factory),
    unscopedFactory: undefined!,
    ctx: undefined,
    injectionResolvers: [],
    propertyResolvers: new Map(),
    methodResolvers: new Map(),
  }
}

// An async binding is resolved once, eagerly, while the container initializes, so it cannot be lazy or re-created per
// scope, and nothing can be injected into it after its factory resolves.
function checkAsyncBinding(key: InjectionToken, config: Binding): void {
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

  if (config.injectableProperties.size > 0 || config.injectableMethods.size > 0) {
    throw new ErrInvalidBinding(
      `Cannot configure async binding for key "${keyStr(key)}":` +
        `async bindings cannot have injectable properties or injectable methods.`,
    )
  }
}

function checkInjectableMethods(key: InjectionToken, ctor: Ctor, binding: Binding): void {
  for (const [methodName, injections] of binding.injectableMethods) {
    const method = ctor.prototype?.[methodName as string]
    if (typeof method === 'function' && method.length > injections.length) {
      throw new ErrInvalidBinding(
        `Cannot configure "${keyStr(key)}": method "${String(methodName)}" has ${method.length} parameter(s) but ${injections.length} injection key(s) were specified`,
      )
    }
  }
}

// A class binding opts into container lifecycle by implementing OnBootstrap / OnDestroy. An explicit hook set on the
// spec (or an @OnLifecycle callback) still wins.
function adoptLifecycleInterfaces<T>(ctor: Ctor, binding: Binding<T>): void {
  if (binding.bootstrap === undefined && typeof ctor.prototype?.onBootstrap === 'function') {
    binding.bootstrap = (instance: T) => (instance as OnBootstrap).onBootstrap()
  }
  if (binding.preDestroy === undefined && typeof ctor.prototype?.onDestroy === 'function') {
    binding.preDestroy = (instance: T) => (instance as OnDestroy).onDestroy()
  }
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
  private readonly metadataReader: MetadataReader
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
  private _pendingConditionals: PendingBinding[] = []
  private _pendingConfigClasses = new Set<InjectionToken>()
  private _sortedAsyncEntries: [InjectionToken, Binding][] = []
  private _aspectScopeCache: Set<NamedToken<Scope>> | null = null
  private _hasRequestScoped = false
  private _hasAsync = false

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
  get profiles(): ReadonlySet<string> {
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
   * Registers the config provider under the well-known internal key: what `$i.config` injections and `config`
   * conditions read.
   *
   * Syntax sugar for `bind(Keys.kConfigProvider)`, so the caller chooses any factory strategy and lifetime. A `config`
   * condition reads the provider while the container compiles, before any factory is compiled, so it needs a
   * provider bound with `toValue()` or `toFactory()`.
   *
   * @example
   * ```ts
   * di.bindConfigProvider<AppConfig>(t => t.toValue(configHandle))
   * di.bindConfigProvider<AppConfig>(t => t.toFactory(() => store.current).lifetime(Scopes.TRANSIENT))
   * ```
   */
  bindConfigProvider<T = unknown>(configure: (spec: BindingSpec<T>) => void): this {
    return this.bind(
      Keys.kConfigProvider as InjectionToken<T>,
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

    // Rebinding replaces everything that answers to the key, not only the binding registered under it: a binding
    // named after the key or extending it would otherwise stay a candidate beside the replacement. Those bindings
    // stay registered under their own keys.
    this.bindings.delete(key)
    this.bindingMembers.delete(key)

    this._pendingConditionals = this._pendingConditionals.filter(e => e.key !== key)
    this._pendingConfigClasses.delete(key)

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
   * Profile matching runs during {@link compile} / {@link init}.
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
   * Captures a snapshot of all non-internal bindings in their current state.
   * Works at any point — pre-init or post-init.
   * For testing purposes.
   *
   * It records the registered bindings, the ones still held back for their conditions, and the active profiles.
   */
  snapshot(): Snapshot {
    const entries: [InjectionToken, Binding][] = []

    for (const [key, binding] of this.registry) {
      if (!binding.internal) {
        entries.push([key, snapshotCopy(key, binding)])
      }
    }

    // A held binding belongs to the state as much as a registered one. restore() holds it back again, to be decided by
    // the container it is restored into.
    for (const { key, binding, byHand } of this._pendingConditionals) {
      if (!binding.internal) {
        const copy = snapshotCopy(key, binding)
        Object.defineProperty(copy, kHeld, { value: (byHand ? 'by-hand' : 'decorated') satisfies HeldOrigin })
        entries.push([key, copy])
      }
    }

    return new Snapshot(entries, this._profiles)
  }

  /**
   * Restores bindings from the given snapshot into the container.
   * Must be called before {@link compile}.
   *
   * A binding the snapshot's container had registered is registered as it is: its conditions are not decided again.
   * One it still held back is held here, in place of any binding this container holds for its key, and decided when
   * this container compiles — with the snapshot's profiles active, which restoring adds to this container's own.
   *
   * @throws {@link ErrInvalidContainerState} once the container has been compiled
   */
  restore(snap: Snapshot): void {
    if (this._ready || this._compiled) {
      throw new ErrInvalidContainerState('Cannot restore once the container has been compiled')
    }

    for (const profile of snap.profiles) {
      this._profiles.add(profile)
    }

    const held: PendingBinding[] = []

    for (const [key, binding] of snap.entries()) {
      const origin = (binding as Binding & { [kHeld]?: HeldOrigin })[kHeld]
      if (origin === undefined) {
        this.configureBinding(key, binding)
        continue
      }

      if (isConfigurationClass(binding)) {
        this._pendingConfigClasses.add(key)
      }

      held.push({ key, binding, byHand: origin === 'by-hand' })
    }

    // A container that read the same decorators holds the same bindings already; the snapshot's take their place.
    const restored = new Set(held.map(e => e.key))
    this._pendingConditionals = this._pendingConditionals.filter(e => !restored.has(e.key))

    for (const entry of held) {
      entry.providedByConfig = this.heldConfigurationOf(entry.binding)
      this._pendingConditionals.push(entry)
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

    for (const [key, config] of getBindingConfigurations()) {
      if (!hasInjectable(key)) {
        throw new ErrOrphanedBindingConfig(key)
      }

      const binding = config.binding()

      this.hooks.emit('onSetup', { key, binding })

      if (this.holdsBack(key, binding)) {
        if (isConfigurationClass(binding)) {
          this._pendingConfigClasses.add(key)
        }

        this._pendingConditionals.push({ key, binding, byHand: false })
        continue
      }

      this.configureBinding(key, binding)
      this.hooks.emit('onBindingRegistered', { key, binding })
    }

    for (const [key, config] of providedBindingConfigurations()) {
      const binding = config.binding()

      this.hooks.emit('onSetup', { key, binding })

      // Tied to its own class, the one it was declared in: the key it provides can be provided by another class too.
      const providedByConfig = this.heldConfigurationOf(binding)
      const held = this.holdsBack(key, binding)

      if (held || providedByConfig !== undefined) {
        this._pendingConditionals.push({ key, binding, byHand: false, providedByConfig })
        continue
      }

      if (this.registry.has(key)) {
        throw new ErrRepeatedInjectableConfiguration(
          `Found multiple bindings with the same injection key "${keyStr(key)}" configured at "${binding.configuredBy}"`,
        )
      }

      this.configureBinding(key, binding)
      this.hooks.emit('onBindingRegistered', { key, binding })
    }

    this.hooks.emit('onSetupComplete')
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
      checkAsyncBinding(key, config)
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
      checkInjectableMethods(key, ctor, binding)
      adoptLifecycleInterfaces(ctor, binding)
    }

    const scope = this.scopes.get(scopeID)
    if (scope === undefined && scopeID !== Scopes.TRANSIENT) {
      throw new ErrScopeNotRegistered(scopeID)
    }

    binding.scopeID = scopeID

    // The binding's own setting wins, then the container's, then its scope's; lazy when none says.
    binding.lazy = binding.lazy ?? this.lazy ?? scope?.lazy ?? true

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

  // Whether any of the profiles is active. With none active, no profile is.
  private matchesProfiles(profiles: readonly string[]): boolean {
    return profiles.some(p => this._profiles.has(p))
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
    await this.evaluatePendingConditionals()

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
   * Dependencies are derived from constructor injections only — property and method injections
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
   * Registers a binding made by hand, or holds it back until {@link compile} when it carries conditions.
   *
   * Held back, it is decided with the other held bindings: its conditions never see the binding itself, and a binding
   * already registered under its key stays until they pass. A default bound with `.conditional(c => c.missing(key))`
   * relies on both. Binding the key again discards it, the way it would replace a registered binding.
   */
  private registerOrHold(key: InjectionToken, binding: Binding): void {
    const held = this._pendingConditionals.findIndex(e => e.byHand && e.key === key)
    if (held !== -1) {
      this._pendingConditionals.splice(held, 1)
    }

    if (this.holdsBack(key, binding)) {
      this._pendingConditionals.push({ key, binding, byHand: true })
      return
    }

    this.configureBinding(key, binding)
  }

  /**
   * Settles the binding's conditions and reports whether it carries any, so must wait for {@link compile}.
   *
   * The metadata reader's `conditionals` replace the binding's own, as the reader's fields do in `configureBinding`.
   * Reading them here rather than at registration is what holds back a binding the reader makes conditional.
   */
  private holdsBack(key: InjectionToken, binding: Binding): boolean {
    binding.conditionals = this.metadataReader(key).conditionals ?? binding.conditionals
    return binding.conditionals.length > 0
  }

  // The held @Configuration class a @Provides binding was declared in, when that class is held.
  private heldConfigurationOf(binding: Binding): InjectionToken | undefined {
    const ctor = binding.source?.ctor
    return ctor !== undefined && this._pendingConfigClasses.has(ctor) ? ctor : undefined
  }

  /**
   * Decides every binding held back for its conditions, in the order `decisionOrder` computes.
   *
   * A decorated binding never lands on a registered key. When two bindings of one key are decided and one of them is
   * decorated, whichever comes second throws rather than silently replacing the other.
   */
  private async evaluatePendingConditionals(): Promise<void> {
    const released = new Set<InjectionToken>()
    let config: { values: unknown } | undefined

    // Read once, by the first `config` condition decided: the provider is not read again while this compile lasts.
    const readConfig = (key: InjectionToken, condition: ConfigCondition): unknown => {
      config ??= { values: this.readConfigProvider(key, condition) }
      return config.values
    }

    for (const entry of decisionOrder(this._pendingConditionals)) {
      const { key, binding } = entry

      // The class came first; a @Provides binding whose class did not register is not decided at all.
      if (entry.providedByConfig !== undefined && !this.registry.has(entry.providedByConfig)) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      if (!(await this.passes(key, binding.conditionals, readConfig))) {
        this.hooks.emit('onBindingNotRegistered', { key, binding })
        continue
      }

      if (entry.byHand ? released.has(key) : this.registry.has(key)) {
        throw new ErrRepeatedInjectableConfiguration(
          `Cannot register "${keyStr(key)}"` +
            (binding.configuredBy === undefined ? '' : ` configured at "${binding.configuredBy}"`) +
            `: another binding is registered under the key, and a decorated binding decided at compile() does not replace one` +
            solutions(
              `Replace the decorated binding with rebind(key, ...), which also drops it before it is decided`,
              `Make one of them a default that yields to the other with c => c.missing(key)`,
            ),
        )
      }

      this.configureBinding(key, binding)

      if (!entry.byHand) {
        released.add(key)
      }

      this.hooks.emit('onBindingRegistered', { key, binding })
    }

    this._pendingConditionals = []
    this._pendingConfigClasses.clear()
  }

  // Tests the conditions in rank order, stopping at the first that fails; only a `when` that returns a promise is awaited.
  private async passes(
    key: InjectionToken,
    conditions: readonly Condition[],
    readConfig: (key: InjectionToken, condition: ConfigCondition) => unknown,
  ): Promise<boolean> {
    const ordered = conditions.length > 1 ? [...conditions].sort((a, b) => rank(a) - rank(b)) : conditions

    for (const condition of ordered) {
      const result = this.test(key, condition, readConfig)
      if (!(typeof result === 'boolean' ? result : await result)) {
        return false
      }
    }

    return true
  }

  private test(
    key: InjectionToken,
    condition: Condition,
    readConfig: (key: InjectionToken, condition: ConfigCondition) => unknown,
  ): boolean | Promise<boolean> {
    switch (condition.kind) {
      case 'present':
        return this.has(condition.key)
      case 'missing':
        return !this.has(condition.key)
      case 'profile':
        return this.matchesProfiles(condition.profiles)
      case 'env': {
        const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
          condition.name
        ]
        return condition.expected === undefined ? value !== undefined && value !== '' : value === condition.expected
      }
      case 'config':
        return configSelector(condition.access)(readConfig(key, condition)) === condition.expected
      case 'when':
        return condition.test()
    }
  }

  /**
   * Reads the configuration a `config` condition selects from, through the config provider's own factory.
   *
   * Conditions are decided before any factory is compiled, so the provider must be one that needs no compiling: a
   * value, or a factory with no injections.
   *
   * @throws {@link ErrNoConfigProvider} when no config provider is bound
   * @throws {@link ErrInvalidBinding} when the provider needs compiling to be read
   */
  private readConfigProvider(key: InjectionToken, condition: ConfigCondition): unknown {
    const access = typeof condition.access === 'string' ? `"${condition.access}"` : 'selector'
    const context = `condition config(${access}) of "${keyStr(key)}"`
    const provider = this.getBinding(Keys.kConfigProvider)

    if (provider === undefined) {
      throw new ErrNoConfigProvider(`Required by the ${context}`)
    }

    if (provider.factory === undefined || provider.injections.length > 0 || provider.async) {
      throw new ErrInvalidBinding(
        `Cannot read the config provider for the ${context}: it is read before the container compiles, so it must be bound with toValue() or toFactory()`,
      )
    }

    return (provider.factory as Factory<unknown>)({ container: this, key: Keys.kConfigProvider, binding: provider })
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

    for (const injections of binding.injectableMethods.values()) {
      for (let i = 0; i < injections.length; i++) {
        push(injections[i].key as InjectionToken | undefined)
      }
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
