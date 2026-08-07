import { AOPBinderOptions } from './aop_binder_options.js'
import { type Binding } from './binding.js'
import { Binder } from './binder.js'
import { type BinderOptions } from './binder_options.js'
import { type AsyncFactory, type Factory } from './factory.js'
import { type Injection } from './injection.js'
import { type Key } from './key.js'
import { type Ctor } from './types.js'

/**
 * Fluent builder returned by {@link CaffeineIoC.aspect} for configuring a manually registered AOP aspect.
 * Extends {@link Binder} so aspects can use all factory methods (`.toSelf()`, `.toFactory()`,
 * `.toAsyncFactory()`, etc.) while returning {@link AOPBinderOptions} to expose `.pointcuts()`.
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
export class AOPBinder<T> extends Binder<T> {
  private wrap<V>(opts: BinderOptions<V>): AOPBinderOptions<V> {
    return new AOPBinderOptions<V>(opts.key, opts.binding as Binding<V>, this.register)
  }

  override toSelf(injections: Injection[] = []): AOPBinderOptions<T> {
    return this.wrap(super.toSelf(injections))
  }

  override toClass<V extends T>(ctor: Ctor<V>, injections: Injection[] = []): AOPBinderOptions<V> {
    return this.wrap(super.toClass(ctor, injections))
  }

  override toFactory<V extends T>(factory: Factory<V>): AOPBinderOptions<V> {
    return this.wrap(super.toFactory(factory))
  }

  override toAsyncFactory<V extends T>(factory: AsyncFactory<V>): AOPBinderOptions<V> {
    return this.wrap(super.toAsyncFactory(factory))
  }

  override toValue<V extends T>(value: V): AOPBinderOptions<V> {
    return this.wrap(super.toValue(value))
  }

  override toFunction<V extends T>(fn: (...args: any[]) => V, injections: Injection[] = []): AOPBinderOptions<V> {
    return this.wrap(super.toFunction(fn, injections))
  }

  override aliasOf(targetKey: Key<T>): AOPBinderOptions<T> {
    return this.wrap(super.aliasOf(targetKey))
  }
}
