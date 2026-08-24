import { $aop, kAspectLabel, kAspectPointcuts, type Pointcut, type PointcutBuilders } from '../aop.js'
import { ErrInvalidDecorator } from '../errors.js'
import type { Injection } from '../injection.js'
import { Scopes } from '../scope.js'
import { Ctor } from '../types.js'
import { defineInjectable } from './registrar/index.js'

/**
 * Marks a class as an AOP aspect and registers it as a container-managed singleton.
 *
 * The aspect class must implement {@link MethodAspect} and will be resolved by the container.
 * Constructor dependencies are declared as the first argument — no separate `@Injectable` needed.
 *
 * Use `@Order(n)` on the aspect class to control weaving order when multiple aspects target the
 * same method. Lower value = outermost wrapper (executed first in onion model).
 *
 * @param pointcuts - Either an array of pointcut descriptors built via `$aop.forClass` or
 * `$aop.pointcut`, or a builder function that receives the builtin pointcut builders so no
 * `$aop` import is needed.
 * @param deps - Constructor injections for this aspect class. Pass `[]` for no dependencies.
 *
 * @example
 * ```ts
 * @Aspect([$aop.forClass(UserService, 'findUser')])
 * class LoggingAspect implements MethodAspect<UserService> { ... }
 *
 * @Aspect(p => [p.forClass(UserService, 'findUser')])
 * class LoggingAspect2 implements MethodAspect<UserService> { ... }
 *
 * @Order(1)
 * @Aspect(
 *   [$aop.forClass(OrderService), $aop.pointcut($aop.matchLabel(kService), $aop.matchMethod('save'))],
 *   [Logger],
 * )
 * class TimingAspect implements MethodAspect {
 *   constructor(private log: Logger) {}
 * }
 * ```
 */
export function Aspect(
  pointcuts: Pointcut[],
  deps?: Injection[],
): (aspectClass: Ctor, context: ClassDecoratorContext) => void
export function Aspect(
  build: (p: PointcutBuilders) => Pointcut[],
  deps?: Injection[],
): (aspectClass: Ctor, context: ClassDecoratorContext) => void
export function Aspect(arg: Pointcut[] | ((p: PointcutBuilders) => Pointcut[]), deps: Injection[] = []) {
  const pointcuts = typeof arg === 'function' ? arg($aop) : arg

  return (aspectClass: Ctor, context: ClassDecoratorContext): void => {
    if (pointcuts.length === 0) {
      throw new ErrInvalidDecorator(
        `Cannot configure @Aspect on "${String(context.name)}": at least one pointcut is required`,
      )
    }

    defineInjectable(context.metadata, aspectClass, config => {
      config
        .type(aspectClass)
        .label(kAspectLabel)
        .dependencies(deps)
        .scope(Scopes.SINGLETON)
        .tag(kAspectPointcuts, pointcuts)
    })
  }
}
