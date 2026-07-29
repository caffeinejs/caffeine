import { BinderOptions } from './binder_options.js'
import { AsyncFactory, Factory } from './factory.js'
import { Key, TypedKey, isNamedKey, keyStr } from './key.js'
import { Injection, InjectionDescriptor } from './injection.js'
import { Binding } from './binding.js'
import { check } from './internal/util/assert/index.js'
import { ErrInvalidBinding, ErrNoResolutionForKey } from './errors.js'
import { valueFactory } from './internal/core/factory/value.js'
import { Ctor } from './types.js'
import { functionFactory } from './internal/core/factory/function_closure.js'

/**
 * Fluent builder for configuring how a key resolves in the container.
 */
export class Binder<TValue> {
  private readonly key: Key<TValue> | undefined
  private readonly binding: Binding<any>
  private readonly register: ((binding: Binding<any>) => void) | undefined

  constructor(key: Key<TValue>, binding: Binding<TValue>, register?: (binding: Binding<any>) => void)
  constructor(binding: Binding<TValue>)
  constructor(
    keyOrBinding: Key<TValue> | Binding<TValue>,
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

  get [Symbol.toStringTag]() {
    return Binder.name
  }

  /**
   * Binds the key to the given class constructor.
   *
   * @param ctor - The class constructor to bind.
   * @param injections - The injections to bind to the class constructor.
   *
   * @example
   * ```ts
   * container
   *  .bind(key)
   *  .toClass(Controller, [Repository, $i.optional(NotificationService)])
   * ```
   */
  toClass<V extends TValue>(ctor: Ctor<V>, injections: Injection[] = []): BinderOptions<V> {
    check(typeof ctor === 'function', `Binder .toClass() parameter must be class reference. Received: '${typeof ctor}'`)

    if (injections.length > 0) {
      const normalized = injections.map(dep => typeof dep === 'object' ? (dep as InjectionDescriptor) : { key: dep })

      if (normalized.length !== ctor.length) {
        throw new ErrInvalidBinding(
          `Cannot bind "${ctor.name}": constructor has ${ctor.length} parameter(s) but ${normalized.length} injection(s) were provided`,
        )
      }

      this.binding.injections = normalized
    }

    this.binding.type = ctor
    this.register?.(this.binding)

    return new BinderOptions<V>(this.key, this.binding as Binding<V>, this.register)
  }

  /**
   * Binds the key to itself.
   * The class constructor will be the key to resolve to itself.
   * Shortcut for .bind(Class).toClass(Class)
   * toSelf only works for class types.
   *
   * @param injections - The injections to bind to the key.
   *
   * @example
   * ```ts
   * container
   *  .bind(Controller)
   *  .toSelf([Repository, $i.optional(NotificationService)])
   *
   * const controller = container.get(Controller)
   * ```
   */
  toSelf(injections: Injection[] = []): BinderOptions<TValue> {
    if (isNamedKey(this.key)) {
      throw new ErrInvalidBinding(
        `Cannot use .toSelf() when the binding key is not a class type: current key "${keyStr(this.key)}" is of type "${typeof this.key}"`,
      )
    }

    return this.toClass(this.key as Ctor, injections)
  }

  /**
   * Binds the key to the given value.
   *
   * @param value - The value to bind to the key.
   *
   * @example
   * ```ts
   * container.bind(key).toValue(42)
   *
   * const value = container.get(key) // 42
   * ```
   */
  toValue<V extends TValue>(value: V): BinderOptions<V> {
    check(value !== undefined, `Binder .toValue() parameter must be defined.`)

    this.binding.factory = valueFactory(value)
    this.binding.injections = []
    this.register?.(this.binding)

    return new BinderOptions<V>(this.key, this.binding as Binding<V>, this.register)
  }

  /**
   * Binds the key to the given factory.
   * The factory will be called to create the value when the key is resolved.
   *
   * @param factory - The factory to bind to the key.
   *
   * @example
   * ```ts
   * container
   *  .bind(Controller)
   *  .toFactory(() => new Controller())
   * ```
   */
  toFactory<V extends TValue>(factory: Factory<V>): BinderOptions<V> {
    check(
      typeof factory === 'function',
      `Binder .toFactory() parameter must be a function. Received: '${typeof factory}'`,
    )

    this.binding.factory = factory
    this.binding.injections = []
    this.register?.(this.binding)

    return new BinderOptions<V>(this.key, this.binding as Binding<V>, this.register)
  }

  /**
   * Binds the key to the given async factory.
   * The async factory will be called to create the value when the key is resolved.
   *
   * @param factory - The async factory to bind to the key.
   *
   * @example
   * ```ts
   * container.bind(key).toAsyncFactory(async () => new Controller())
   * const controller = container.get(key)
   * ```
   */
  toAsyncFactory<V extends TValue>(factory: AsyncFactory<V>): BinderOptions<V> {
    check(
      typeof factory === 'function',
      `Binder .toAsyncFactory() parameter must be a function. Received: '${typeof factory}'`,
    )

    this.binding.async = true
    this.binding.factory = factory
    this.register?.(this.binding)

    return new BinderOptions<V>(this.key, this.binding as Binding<V>, this.register)
  }

  /**
   * Binds the key to the given function.
   * The function will be called to create the value when the key is resolved.
   * The provided function can return anything.
   * Note that it must be synchronous.
   *
   * @param fn - The function to bind to the key.
   * @param injections - The injections to bind to the function.
   *
   * @example
   * ```ts
   * container.bind(key).toFunction((repo, service) => new Controller(repo, service))
   * const controller = container.get(key)
   *
   * container
   *  .bind(key)
   *  .toFunction((repository) => ({ greet: () => repository.greet() }), [Repository])
   * const obj = container.get(key)
   * obj.greet() // 'hello'
   * ```
   */
  toFunction<V extends TValue>(fn: (...args: any[]) => V, injections: Injection[] = []): BinderOptions<V> {
    check(typeof fn === 'function', `Binder .toFunction() parameter must be a function. Received: '${typeof fn}'`)

    const normalized = injections
      .map(dep => typeof dep === 'object' ? (dep as InjectionDescriptor) : { key: dep })

    if (normalized.length !== fn.length) {
      throw new ErrInvalidBinding(
        `Cannot bind function "${fn.name || '<anonymous>'}": function has ${fn.length} parameter(s) but ${normalized.length} injection(s) were provided`,
      )
    }

    this.binding.factory = functionFactory<V>(fn)
    this.binding.injections = normalized
    this.register?.(this.binding)

    return new BinderOptions<V>(this.key, this.binding as Binding<V>, this.register)
  }

  /**
   * Binds the key as an alias of the given target key.
   * Resolving this key will delegate to the target's factory, including its scope.
   *
   * @param targetKey - The key to alias.
   *
   * @example
   * ```ts
   * container.bind(AbstractRepo).aliasOf(ConcreteRepo)
   * container.get(AbstractRepo) === container.get(ConcreteRepo) // true (singleton)
   * ```
   */
  aliasOf(targetKey: Key<TValue>): BinderOptions<TValue> {
    this.binding.factoryCreator = (_k, _b, container): Factory<TValue> => {
      const other = container.getBinding(targetKey as TypedKey<TValue>)
      if (!other) {
        throw new ErrNoResolutionForKey(
          `Cannot resolve alias "${keyStr(this.key!)}": no binding registered for key "${keyStr(targetKey)}"`,
        )
      }
      return () => (other.factory as Factory<TValue>)(other.ctx!)
    }
    this.register?.(this.binding)

    return new BinderOptions<TValue>(this.key, this.binding as Binding<TValue>, this.register)
  }
}
