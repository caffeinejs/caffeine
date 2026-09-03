import { Binding } from './binding.js'
import { Conditional } from './conditional.js'
import { DeferredCtor } from './deferred_ctor.js'
import { ErrInvalidBinding, ErrNoResolutionForKey } from './errors.js'
import { AsyncFactory, Factory } from './factory.js'
import { Injection, InjectionDescriptor, InjectionsFor, ResolveInjection } from './injection.js'
import { functionFactory } from './internal/core/factory/function_closure.js'
import { valueFactory } from './internal/core/factory/value.js'
import { check, notNil } from './internal/util/assert/index.js'
import { solutions } from './internal/util/errutil/index.js'
import { InjectionToken, Identifier, TypedKey, isNamedKey, keyStr } from './key.js'
import { PostResolutionInterceptor } from './post_resolution_interceptor.js'
import { hasScope } from './scope.js'
import { AbstractCtor, Ctor } from './types.js'

/**
 * Materializes the accumulated {@link Binding}. Called by the container once the configure callback returns.
 *
 * @internal
 */
export const kBuildBinding: unique symbol = Symbol('@caffeinejs/di:build-binding')

/**
 * Reported when `toSelf` is reached on a key that cannot be constructed — a named key, an abstract class.
 */
export type ToSelfNeedsAClassKey<K> = { readonly __toSelfRequiresAClassKey: K }

/**
 * Parameters accepted by `toSelf` for the key `K`: the injections matching the key's own constructor.
 * A key that cannot be constructed accepts no call at all.
 */
export type SelfInjections<K> =
  K extends Ctor<any, infer A> ? [injections?: InjectionsFor<A>] : [key: ToSelfNeedsAClassKey<K>]

/**
 * Configures how a key resolves in the container.
 *
 * Every method returns the same instance, so a binding is described in one chain and registered once, when the
 * callback given to {@link CaffeineIoC.bind} returns.
 *
 * @example
 * ```ts
 * container
 *   .bind(Controller, t => t.toClass(Controller, [Repository]).lifetime(Scopes.SINGLETON))
 *   .bind(kPort, t => t.toValue(8080))
 * ```
 */
export class BindingSpec<TValue, K = unknown> {
  protected readonly key: InjectionToken<TValue> | undefined
  protected readonly binding: Binding<any>

  constructor(key: InjectionToken<TValue>, binding: Binding<TValue>) {
    this.key = key
    this.binding = binding
  }

  get [Symbol.toStringTag]() {
    return BindingSpec.name
  }

  /**
   * Binds the key to the given class constructor.
   *
   * `ctor` itself cannot appear in `injections` — a component is not its own dependency. Use `$i.defer` when
   * the cycle is intended.
   *
   * @param ctor - The class constructor to bind.
   * @param injections - One injection per constructor parameter, in order.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(Controller, [Repository, $i.optional(NotificationService)]))
   * ```
   */
  toClass<V extends TValue, A extends unknown[]>(ctor: Ctor<V, A>, injections?: InjectionsFor<A>): this {
    check(
      typeof ctor === 'function',
      `BindingSpec .toClass() parameter must be class reference. Received: '${typeof ctor}'`,
    )

    const deps = (injections ?? []) as Injection[]

    if (deps.length > 0) {
      const normalized = deps.map(dep => (typeof dep === 'object' ? (dep as InjectionDescriptor) : { key: dep }))

      if (normalized.length !== ctor.length) {
        throw new ErrInvalidBinding(
          `Cannot bind "${ctor.name}": constructor has ${ctor.length} parameter(s) but ${normalized.length} injection(s) were provided`,
        )
      }

      for (const injection of normalized) {
        if (injection.key === ctor || (this.key !== undefined && injection.key === this.key)) {
          throw new ErrInvalidBinding(
            `Cannot bind "${ctor.name}": a component cannot be its own dependency` +
              solutions(
                `- Remove "${ctor.name}" from the injection list`,
                `- Use $i.defer(() => ${ctor.name}) if the cycle is intended, so the key resolves lazily`,
              ),
          )
        }
      }

      this.binding.injections = normalized
    }

    this.binding.type = ctor

    return this
  }

  /**
   * Binds the key to itself.
   * The class constructor will be the key to resolve to itself.
   * Shortcut for `.bind(Class, t => t.toClass(Class))`.
   * toSelf only works for class types.
   *
   * The key itself cannot appear in the injections — a component is not its own dependency. Use `$i.defer`
   * when the cycle is intended.
   *
   * @example
   * ```ts
   * container.bind(Controller, t => t.toSelf([Repository, $i.optional(NotificationService)]))
   *
   * const controller = container.get(Controller)
   * ```
   */
  toSelf(...args: SelfInjections<K>): this {
    if (isNamedKey(this.key)) {
      throw new ErrInvalidBinding(
        `Cannot use .toSelf() when the binding key is not a class type: current key "${keyStr(this.key)}" is of type "${typeof this.key}"`,
      )
    }

    return this.toClass(this.key as Ctor, args[0] as InjectionsFor<unknown[]>)
  }

  /**
   * Binds the key to the given value.
   *
   * @param value - The value to bind to the key.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toValue(42))
   *
   * const value = container.get(key) // 42
   * ```
   */
  toValue<V extends TValue>(value: V): this {
    check(value !== undefined, `BindingSpec .toValue() parameter must be defined.`)

    this.binding.factory = valueFactory(value)
    this.binding.injections = []

    return this
  }

  /**
   * Binds the key to the given factory.
   * The factory will be called to create the value when the key is resolved.
   *
   * @param factory - The factory to bind to the key.
   *
   * @example
   * ```ts
   * container.bind(Controller, t => t.toFactory(() => new Controller()))
   * ```
   */
  toFactory<V extends TValue>(factory: Factory<V>): this {
    check(
      typeof factory === 'function',
      `BindingSpec .toFactory() parameter must be a function. Received: '${typeof factory}'`,
    )

    this.binding.factory = factory
    this.binding.injections = []

    return this
  }

  /**
   * Binds the key to the given async factory.
   * The async factory will be called to create the value when the key is resolved.
   *
   * @param factory - The async factory to bind to the key.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toAsyncFactory(async () => new Controller()))
   * const controller = container.get(key)
   * ```
   */
  toAsyncFactory<V extends TValue>(factory: AsyncFactory<V>): this {
    check(
      typeof factory === 'function',
      `BindingSpec .toAsyncFactory() parameter must be a function. Received: '${typeof factory}'`,
    )

    this.binding.async = true
    this.binding.factory = factory

    return this
  }

  /**
   * Binds the key to the given function.
   * The function will be called to create the value when the key is resolved.
   * The provided function can return anything.
   * Note that it must be synchronous.
   *
   * The function's parameters are typed from `injections`, so a dependency list of
   * `[Repository]` types the first parameter as `Repository`.
   *
   * @param fn - The function to bind to the key.
   * @param injections - One injection per function parameter, in order.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toFunction(repository => ({ greet: () => repository.greet() }), [Repository]))
   *
   * const obj = container.get(key)
   * obj.greet() // 'hello'
   * ```
   */
  toFunction<const I extends readonly Injection<any>[], V extends TValue>(
    fn: (...args: { [P in keyof I]: ResolveInjection<I[P]> }) => V,
    injections?: I,
  ): this {
    check(typeof fn === 'function', `BindingSpec .toFunction() parameter must be a function. Received: '${typeof fn}'`)

    const normalized = ((injections ?? []) as Injection[]).map(dep =>
      typeof dep === 'object' ? (dep as InjectionDescriptor) : { key: dep },
    )

    if (normalized.length !== fn.length) {
      throw new ErrInvalidBinding(
        `Cannot bind function "${fn.name || '<anonymous>'}": function has ${fn.length} parameter(s) but ${normalized.length} injection(s) were provided`,
      )
    }

    this.binding.factory = functionFactory<V>(fn as (...args: unknown[]) => V)
    this.binding.injections = normalized

    return this
  }

  /**
   * Binds the key as an alias of the given target key.
   * Resolving this key will delegate to the target's factory, including its scope.
   *
   * @param targetKey - The key to alias.
   *
   * @example
   * ```ts
   * container.bind(AbstractRepo, t => t.aliasOf(ConcreteRepo))
   * container.get(AbstractRepo) === container.get(ConcreteRepo) // true (singleton)
   * ```
   */
  aliasOf(targetKey: InjectionToken<TValue>): this {
    this.binding.factoryCreator = (_k, _b, container): Factory<TValue> => {
      const other = container.getBinding(targetKey as TypedKey<TValue>)
      if (!other) {
        throw new ErrNoResolutionForKey(
          `Cannot resolve alias "${keyStr(this.key!)}": no binding registered for key "${keyStr(targetKey)}"`,
        )
      }
      return () => (other.factory as Factory<TValue>)(other.ctx!)
    }

    return this
  }

  /**
   * Sets the scope that controls the instance lifecycle of this binding.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(Service).lifetime(Scopes.SINGLETON))
   * ```
   */
  lifetime(scopeID: Identifier): this {
    if (!hasScope(notNil(scopeID))) {
      throw new ErrInvalidBinding(
        `Scope "${String(scopeID)}" is not registered: use bindScope() to register it before use`,
      )
    }

    this.binding.scopeID = scopeID

    return this
  }

  /**
   * Registers one or more string/symbol names that can be used to resolve this binding.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(Service).names('myService', 'legacyService'))
   * ```
   */
  names(name: Identifier, ...names: Identifier[]): this {
    notNil(name, `Parameter name must not be null or undefined`)

    this.binding.names = [...new Set([...this.binding.names, ...[name, ...names]])]

    return this
  }

  /**
   * Defers instantiation of this binding until it is first resolved.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(Service).lazy())
   * ```
   */
  lazy(lazy = true): this {
    this.binding.lazy = lazy

    return this
  }

  /**
   * Marks this binding as the preferred candidate when multiple bindings match the same key.
   *
   * @example
   * ```ts
   * container.bind(Logger, t => t.toClass(FileLogger).primary())
   * ```
   */
  primary(primary = true): this {
    this.binding.primary = primary

    return this
  }

  /**
   * Skips all registered post-processors when resolving this binding.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toValue(rawConfig).byPassPostProcessors())
   * ```
   */
  byPassPostProcessors(): this {
    this.binding.byPassPostProcessors = true

    return this
  }

  /**
   * Marks this binding as a fallback that resolves only when no other binding matches.
   *
   * @example
   * ```ts
   * container.bind(Logger, t => t.toClass(NoopLogger).fallback())
   * ```
   */
  fallback(fallback = true): this {
    this.binding.fallback = fallback

    return this
  }

  /**
   * Sets the sort position of this binding when resolved via {@link ordered}.
   * Bindings with lower values are placed first. Bindings without an order are placed last,
   * preserving their original registration order among themselves.
   *
   * @param order - Non-negative integer that determines the position in the sorted result.
   *
   * @example
   * ```ts
   * container
   *   .bind(PluginA, t => t.toSelf().extends(Plugin).order(1))
   *   .bind(PluginB, t => t.toSelf().extends(Plugin).order(2))
   * ```
   */
  order(order: number): this {
    this.binding.order = order

    return this
  }

  /**
   * Configures property injection for the bound class without relying on decorators.
   *
   * @example
   * ```ts
   * container.bind(Controller, t => t.toSelf().injectProperty('repo', Repository))
   * ```
   */
  injectProperty(property: Identifier, injection: Injection): this {
    if (typeof this.key !== 'function') {
      throw new ErrInvalidBinding(
        `Cannot call injectProperty() on key "${String(this.key)}": property injection requires a class binding`,
      )
    }

    const descriptor: InjectionDescriptor =
      typeof injection === 'object' && !(injection instanceof DeferredCtor)
        ? (injection as InjectionDescriptor)
        : { key: injection as InjectionToken }

    this.binding.injectableProperties.set(property, descriptor)

    return this
  }

  /**
   * Configures method injection for the bound class, calling the method after construction with the given deps.
   *
   * @example
   * ```ts
   * container.bind(Controller, t => t.toSelf().injectMethod('init', Repository, Cache))
   * ```
   */
  injectMethod(method: Identifier, ...deps: Injection[]): this {
    if (typeof this.key !== 'function') {
      throw new ErrInvalidBinding(
        `Cannot call injectMethod() on key "${String(this.key)}": method injection requires a class binding`,
      )
    }

    const descriptors: InjectionDescriptor[] = deps.map(dep =>
      typeof dep === 'object' && !(dep instanceof DeferredCtor)
        ? (dep as InjectionDescriptor)
        : { key: dep as InjectionToken },
    )

    this.binding.injectableMethods.set(method, descriptors)

    return this
  }

  /**
   * Attaches one or more symbol labels to the binding for group-resolution via `getMany`.
   *
   * @example
   * ```ts
   * const Plugin = token<MyPlugin>(Symbol('Plugin'))
   * container.bind(key, t => t.toClass(MyPlugin).labels(Plugin))
   * container.getMany(Plugin) // [MyPlugin instance]
   * ```
   */
  labels(label: symbol, ...labels: symbol[]): this {
    notNil(label, `Parameter label must not be null or undefined`)

    this.binding.labels = [...new Set([...this.binding.labels, ...[label, ...labels]])]

    return this
  }

  tags(key: symbol, value: unknown): this
  tags(entries: Map<symbol, unknown>): this
  /**
   * Attaches arbitrary symbol-keyed metadata tags to the binding.
   *
   * @example
   * ```ts
   * const Priority = Symbol('Priority')
   * container.bind(key, t => t.toClass(Service).tags(Priority, 10))
   * ```
   */
  tags(keyOrEntries: symbol | Map<symbol, unknown>, value?: unknown): this {
    notNil(keyOrEntries, `Parameter key or entries must not be null or undefined`)

    if (keyOrEntries instanceof Map) {
      for (const [k, v] of keyOrEntries) {
        this.binding.tags.set(k, v)
      }
    } else {
      this.binding.tags.set(notNil(keyOrEntries), value)
    }

    return this
  }

  /**
   * Registers a callback invoked once after the instance is fully constructed and injected.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(Service).postConstruct(svc => svc.connect()))
   * ```
   */
  postConstruct(fn: (value: TValue) => void): this {
    notNil(fn, `Parameter fn must not be null or undefined`)

    this.binding.postConstruct = fn

    return this
  }

  /**
   * Registers a callback invoked when the container destroys this binding's instance.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(DbService).preDestroy(svc => svc.disconnect()))
   * ```
   */
  preDestroy(fn: (value: TValue) => void | Promise<void>): this {
    notNil(fn, `Parameter fn must not be null or undefined`)

    this.binding.preDestroy = fn

    return this
  }

  /**
   * Adds a post-resolution interceptor that can wrap or transform the resolved instance.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(Service).intercept((instance, ctx) => new Proxy(instance, handler)))
   * ```
   */
  intercept(interceptor: PostResolutionInterceptor<TValue>): this {
    notNil(interceptor, `Parameter interceptor must not be null or undefined`)

    this.binding.interceptors.push(interceptor)

    return this
  }

  /**
   * Attaches one or more predicates that must all return `true` for this binding to be active.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(ProdService).conditional(ctx => process.env.NODE_ENV === 'production'))
   * ```
   */
  conditional(fn: Conditional | Conditional[]): this {
    const fns = Array.isArray(fn) ? fn : [fn]
    this.binding.conditionals = [...(this.binding.conditionals ?? []), ...fns]

    return this
  }

  /**
   * Restricts this binding to the given profiles. The binding is only active when
   * one of the given profiles is enabled in the container.
   *
   * @example
   * ```ts
   * container.bind(key, t => t.toClass(MockEmailService).profiles('test', 'development'))
   * ```
   */
  profiles(profile: Identifier, ...profiles: Identifier[]): this {
    notNil(profile, `Parameter profile must not be null or undefined`)

    this.binding.profiles.add(profile)
    for (const p of profiles) {
      this.binding.profiles.add(p)
    }

    return this
  }

  /**
   * Declares the base class this binding's concrete type extends, enabling polymorphic resolution.
   * Usually used with abstract classes.
   * With this, the abstract class constructor can be used as the key to
   * resolve to the concrete type.
   *
   * Omit `base` to infer the extended class automatically.
   *
   * @example
   * ```ts
   * abstract class Repo {}
   *
   * class SqlRepo extends Repo {}
   *
   * container.bind(SqlRepo, t => t.toSelf().extends())
   * container.get(Repo) // SqlRepo instance
   * ```
   */
  extends(): this
  extends(base: Ctor | AbstractCtor): this
  extends(base?: Ctor | AbstractCtor): this {
    const concreteType: Ctor | undefined =
      this.binding.type !== undefined
        ? (this.binding.type as Ctor)
        : typeof this.key === 'function'
          ? (this.key as Ctor)
          : undefined

    if (base === undefined) {
      if (concreteType === undefined) {
        throw new ErrInvalidBinding(
          `Cannot use parameterless .extends(): concrete type could not be determined. Call .toClass() or .toSelf() first`,
        )
      }
      const parent = Object.getPrototypeOf(concreteType)
      if (parent === Function.prototype) {
        throw new ErrInvalidBinding(
          `Cannot use parameterless .extends() for "${concreteType.name}": "${concreteType.name}" does not explicitly extend a class`,
        )
      }
      base = parent
    } else {
      notNil(base, `Parameter base must not be null or undefined`)

      if (typeof base !== 'function') {
        throw new ErrInvalidBinding(`Cannot configure .extends(): base must be a class reference (typeof 'function')`)
      }

      if (concreteType !== undefined && !(concreteType.prototype instanceof base)) {
        throw new ErrInvalidBinding(
          `Cannot configure .extends() for "${concreteType.name}": "${concreteType.name}" does not extend "${(base as AbstractCtor).name}"`,
        )
      }
    }

    this.binding.extend = base

    return this
  }

  /**
   * Marks this binding as internal.
   *
   * @internal
   */
  internal(): this {
    this.binding.internal = true

    return this
  }

  /**
   * @internal
   */
  [kBuildBinding](): Binding<any> {
    return this.binding
  }
}
