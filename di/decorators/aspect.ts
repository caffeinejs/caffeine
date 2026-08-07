import { kAspectLabel, kAspectPointcuts, incrementAspectCount, type Pointcut } from '../aop.js'
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
 * @param deps - Constructor injections for this aspect class. Pass `[]` for no dependencies.
 * @param pointcuts - One or more pointcut descriptors built via `$aop.forClass` or `$aop.pointcut`.
 *
 * @example
 * ```ts
 * @Aspect([], $aop.forClass(UserService, 'findUser'))
 * class LoggingAspect implements MethodAspect<UserService> { ... }
 *
 * @Order(1)
 * @Aspect(
 *   [Logger],
 *   $aop.forClass(OrderService),
 *   $aop.pointcut($aop.matchLabel(kService), $aop.matchMethod('save')),
 * )
 * class TimingAspect implements MethodAspect {
 *   constructor(private log: Logger) {}
 * }
 * ```
 */
export function Aspect(deps: Injection[], ...pointcuts: Pointcut[]) {
  return (aspectClass: Ctor, context: ClassDecoratorContext): void => {
    if (pointcuts.length === 0) {
      throw new ErrInvalidDecorator(
        `Cannot configure @Aspect on "${String(context.name)}": at least one pointcut is required`,
      )
    }

    incrementAspectCount()

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
