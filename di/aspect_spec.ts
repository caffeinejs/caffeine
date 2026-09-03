import { kAspectPointcuts, type Pointcut } from './aop.js'
import { BindingSpec } from './binding_spec.js'

/**
 * Configures a manually registered AOP aspect. Extends {@link BindingSpec} with `.pointcuts()`, which declares
 * the targets the aspect intercepts.
 *
 * @example
 * ```ts
 * container.aspect(LoggingAspect, t => t
 *   .toSelf()
 *   .pointcuts($aop.forClass(UserService, 'findUser'))
 *   .conditional(ctx => process.env.NODE_ENV === 'production')
 *   .order(1))
 * ```
 */
export class AspectSpec<TValue, K = unknown> extends BindingSpec<TValue, K> {
  /**
   * Sets the pointcuts this aspect intercepts.
   *
   * @param first - The first (required) pointcut, built via `$aop.forClass` or `$aop.pointcut`.
   * @param rest - Additional pointcuts.
   */
  pointcuts(first: Pointcut, ...rest: Pointcut[]): this {
    this.binding.tags.set(kAspectPointcuts, [first, ...rest])

    return this
  }
}
