import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'

/**
 * Dispatches a decorator usable at class, method, or field level to the matching handler, based
 * on `context.kind`. Private to this directory — a small, fetchy-owned copy of the same shape used
 * by `@caffeinejs/http`'s `defineClassOrMemberDecorator`, kept local since fetchy must not depend
 * on `@caffeinejs/http`.
 */
export function classOrMember(
  decoratorName: string,
  classFn: (target: Function, context: ClassDecoratorContext) => void,
  memberFn: (context: ClassMethodDecoratorContext | ClassFieldDecoratorContext) => void,
): (
  target: Function,
  context: ClassDecoratorContext | ClassMethodDecoratorContext | ClassFieldDecoratorContext,
) => void {
  return function (
    target: Function,
    context: ClassDecoratorContext | ClassMethodDecoratorContext | ClassFieldDecoratorContext,
  ): void {
    if (context.kind === 'class') {
      classFn(target, context)
      return
    }

    if (context.kind === 'method' || context.kind === 'field') {
      memberFn(context)
      return
    }

    throw new ErrFetchyInvalidDecoratorTarget(decoratorName, 'a class, method, or field')
  }
}
