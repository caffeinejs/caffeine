import { kAspectPointcuts, type Pointcut } from './aop.js'
import { BinderOptions } from './binder_options.js'

/**
 * Fluent builder returned by {@link AOPBinder} factory methods for configuring an AOP aspect binding.
 * Extends {@link BinderOptions} with a `.pointcuts()` method to declare which targets this aspect intercepts.
 *
 * @example
 * ```ts
 * container
 *   .aspect(LoggingAspect)
 *   .toSelf()
 *   .pointcuts($aop.forClass(UserService, 'findUser'))
 *   .conditional(ctx => ctx.env === 'production')
 *   .order(1)
 * ```
 */
export class AOPBinderOptions<T> extends BinderOptions<T> {
  /**
   * Sets the pointcuts this aspect intercepts.
   *
   * @param first - The first (required) pointcut, built via `$aop.forClass` or `$aop.pointcut`.
   * @param rest - Additional pointcuts.
   */
  pointcuts(first: Pointcut, ...rest: Pointcut[]): this {
    this.binding.tags.set(kAspectPointcuts, [first, ...rest])
    this.sync()

    return this
  }
}
