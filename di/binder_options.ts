import { Key, Identifier } from './key.js'
import { Binding } from './binding.js'
import { Conditional } from './conditional.js'
import { notNil } from './internal/util/assert/index.js'
import { ErrInvalidBinding } from './errors.js'
import { hasScope } from './scope.js'
import { PostResolutionInterceptor } from './post_resolution_interceptor.js'
import { AbstractCtor, Ctor } from './types.js'
import { Injection, InjectionDescriptor } from './injection.js'
import { DeferredCtor } from './deferred_ctor.js'

/**
 * Fluent API returned by {@link Binder} methods for configuring binding metadata:
 * scope, names, interceptors, and more.
 */
export class BinderOptions<TValue> {
  readonly key: Key<TValue> | undefined
  readonly binding: Binding<TValue>
  private readonly register: ((binding: Binding<any>) => void) | undefined

  constructor(key: Key<TValue> | unknown, binding: Binding<TValue>, register?: (binding: Binding<any>) => void)
  constructor(binding: Binding<TValue>)
  constructor(
    keyOrBinding: Key<TValue> | Binding<TValue> | undefined,
    binding?: Binding<TValue>,
    register?: (binding: Binding<any>) => void,
  ) {
    if (binding === undefined) {
      this.binding = keyOrBinding as Binding<TValue>
    } else {
      this.key = keyOrBinding as Key<TValue>
      this.binding = binding
      this.register = register
    }
  }

  protected sync(): void {
    this.register?.(this.binding)
  }

  get [Symbol.toStringTag]() {
    return BinderOptions.name
  }

  /**
   * Sets the scope that controls the instance lifecycle of this binding.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(Service).lifetime(Scope.Singleton)
   * ```
   */
  lifetime(scopeID: Identifier): this {
    if (!hasScope(notNil(scopeID))) {
      throw new ErrInvalidBinding(
        `Scope "${String(scopeID)}" is not registered: use bindScope() to register it before use`,
      )
    }

    this.binding.scopeID = scopeID
    this.sync()

    return this
  }

  /**
   * Registers one or more string/symbol names that can be used to resolve this binding.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(Service).names('myService', 'legacyService')
   * ```
   */
  names(name: Identifier, ...names: Identifier[]): this {
    notNil(name, `Parameter name must not be null or undefined`)

    this.binding.names = [...new Set([...this.binding.names, ...[name, ...names]])]
    this.sync()

    return this
  }

  /**
   * Defers instantiation of this binding until it is first resolved.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(Service).lazy()
   * ```
   */
  lazy(lazy = true): this {
    this.binding.lazy = lazy
    this.sync()

    return this
  }

  /**
   * Marks this binding as the preferred candidate when multiple bindings match the same key.
   *
   * @example
   * ```ts
   * container.bind(Logger).toClass(FileLogger).primary()
   * ```
   */
  primary(primary = true): this {
    this.binding.primary = primary
    this.sync()

    return this
  }

  /**
   * Skips all registered post-processors when resolving this binding.
   *
   * @example
   * ```ts
   * container.bind(key).toValue(rawConfig).byPassPostProcessors()
   * ```
   */
  byPassPostProcessors(): this {
    this.binding.byPassPostProcessors = true
    this.sync()

    return this
  }

  /**
   * Marks this binding as a fallback that resolves only when no other binding matches.
   *
   * @example
   * ```ts
   * container.bind(Logger).toClass(NoopLogger).fallback()
   * ```
   */
  fallback(fallback = true): this {
    this.binding.fallback = fallback
    this.sync()

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
   * container.bind(PluginA).toClass(PluginA).extends(Plugin).order(1)
   * container.bind(PluginB).toClass(PluginB).extends(Plugin).order(2)
   * ```
   */
  order(order: number): this {
    this.binding.order = order
    this.sync()

    return this
  }

  /**
   * Configures property injection for the bound class without relying on decorators.
   *
   * @example
   * ```ts
   * container.bind(Controller).toClass(Controller).injectProperty('repo', Repository)
   * ```
   */
  injectProperty(property: Identifier, injection: Injection): this {
    if (typeof this.key !== 'function') {
      throw new ErrInvalidBinding(
        `Cannot call injectProperty() on key "${String(this.key)}": property injection requires a class binding`,
      )
    }

    const descriptor: InjectionDescriptor
      = typeof injection === 'object' && !(injection instanceof DeferredCtor)
        ? (injection as InjectionDescriptor)
        : { key: injection as Key }

    this.binding.injectableProperties.set(property, descriptor)
    this.sync()

    return this
  }

  /**
   * Configures method injection for the bound class, calling the method after construction with the given deps.
   *
   * @example
   * ```ts
   * container.bind(Controller).toClass(Controller).injectMethod('init', Repository, Cache)
   * ```
   */
  injectMethod(method: Identifier, ...deps: Injection[]): this {
    if (typeof this.key !== 'function') {
      throw new ErrInvalidBinding(
        `Cannot call injectMethod() on key "${String(this.key)}": method injection requires a class binding`,
      )
    }

    const descriptors: InjectionDescriptor[] = deps.map(dep =>
      typeof dep === 'object' && !(dep instanceof DeferredCtor) ? (dep as InjectionDescriptor) : { key: dep as Key },
    )

    this.binding.injectableMethods.set(method, descriptors)
    this.sync()

    return this
  }

  /**
   * Attaches one or more symbol labels to the binding for group-resolution via `getMany`.
   *
   * @example
   * ```ts
   * const Plugin = Symbol('Plugin')
   * container.bind(key).toClass(MyPlugin).labels(Plugin)
   * container.getMany(Plugin) // [MyPlugin instance]
   * ```
   */
  labels(label: symbol, ...labels: symbol[]): this {
    notNil(label, `Parameter label must not be null or undefined`)

    this.binding.labels = [...new Set([...this.binding.labels, ...[label, ...labels]])]
    this.sync()

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
   * container.bind(key).toClass(Service).tags(Priority, 10)
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

    this.sync()

    return this
  }

  /**
   * Registers a callback invoked once after the instance is fully constructed and injected.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(Service).postConstruct(svc => svc.connect())
   * ```
   */
  postConstruct(fn: (value: TValue) => void): this {
    notNil(fn, `Parameter fn must not be null or undefined`)

    this.binding.postConstruct = fn
    this.sync()

    return this
  }

  /**
   * Registers a callback invoked when the container destroys this binding's instance.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(DbService).preDestroy(svc => svc.disconnect())
   * ```
   */
  preDestroy(fn: (value: TValue) => void | Promise<void>): this {
    notNil(fn, `Parameter fn must not be null or undefined`)

    this.binding.preDestroy = fn
    this.sync()

    return this
  }

  /**
   * Adds a post-resolution interceptor that can wrap or transform the resolved instance.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(Service).intercept((instance, ctx) => new Proxy(instance, handler))
   * ```
   */
  intercept(interceptor: PostResolutionInterceptor<TValue>): this {
    notNil(interceptor, `Parameter interceptor must not be null or undefined`)

    this.binding.interceptors.push(interceptor)
    this.sync()

    return this
  }

  /**
   * Attaches one or more predicates that must all return `true` for this binding to be active.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(ProdService).conditional(ctx => process.env.NODE_ENV === 'production')
   * ```
   */
  conditional(fn: Conditional | Conditional[]): this {
    const fns = Array.isArray(fn) ? fn : [fn]
    this.binding.conditionals = [...this.binding.conditionals ?? [], ...fns]
    this.sync()

    return this
  }

  /**
   * Restricts this binding to the given profiles. The binding is only active when
   * one of the given profiles is enabled in the container.
   *
   * @example
   * ```ts
   * container.bind(key).toClass(MockEmailService).profiles('test', 'development')
   * ```
   */
  profiles(profile: Identifier, ...profiles: Identifier[]): this {
    notNil(profile, `Parameter profile must not be null or undefined`)

    this.binding.profiles.add(profile)
    for (const p of profiles) {
      this.binding.profiles.add(p)
    }
    this.sync()

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
   * container.bind(SqlRepo).toSelf().extends()
   * container.get(Repo) // SqlRepo instance
   * ```
   */
  extends(): this
  extends(base: Ctor | AbstractCtor): this
  extends(base?: Ctor | AbstractCtor): this {
    const concreteType: Ctor | undefined
      = this.binding.type !== undefined
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
    this.sync()

    return this
  }

  /**
   * Marks this binding as internal.
   *
   * @internal
   */
  internal(): this {
    this.binding.internal = true
    this.sync()

    return this
  }
}
