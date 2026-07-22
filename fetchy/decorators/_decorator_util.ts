import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'

/**
 * Dispatches a decorator usable at both class and method level to the matching handler, based on
 * `context.kind`. Private to this directory — a small, fetchy-owned copy of the same shape used by
 * `@caffeinejs/http`'s `defineClassOrMemberDecorator`, kept local since fetchy must not depend on
 * `@caffeinejs/http`.
 */
export function classOrMethod(
  decoratorName: string,
  classFn: (target: Function, context: ClassDecoratorContext) => void,
  methodFn: (context: ClassMethodDecoratorContext) => void,
): (target: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void {
  return function (target: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext): void {
    if (context.kind === 'class') {
      classFn(target, context)
      return
    }

    if (context.kind === 'method') {
      methodFn(context)
      return
    }

    throw new ErrFetchyInvalidDecoratorTarget(decoratorName, 'a class or method')
  }
}
