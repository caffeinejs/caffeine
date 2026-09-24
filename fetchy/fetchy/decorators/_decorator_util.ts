import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'

/**
 * Dispatches a decorator usable at class, method, or field level to the matching handler, based
 * on `context.kind`. Private to this directory — a small, fetchy-owned copy of the same shape used
 * by `@caffeinejs/http`'s `defineClassOrMemberDecorator`, kept local since fetchy must not depend
 * on `@caffeinejs/http`.
 *
 * The first parameter is `unknown` because the three positions disagree about it: a class decorator is
 * handed the constructor, a method decorator the function, and a field decorator `undefined`. Naming it
 * `Function` is what made every decorator built on this one fail `TS1240` on a field-declared operation.
 */
export function classOrMember(
  decoratorName: string,
  classFn: (target: Function, context: ClassDecoratorContext) => void,
  memberFn: (context: ClassMethodDecoratorContext | ClassFieldDecoratorContext) => void,
): (
  target: unknown,
  context: ClassDecoratorContext | ClassMethodDecoratorContext | ClassFieldDecoratorContext,
) => void {
  return function (
    target: unknown,
    context: ClassDecoratorContext | ClassMethodDecoratorContext | ClassFieldDecoratorContext,
  ): void {
    if (context.kind === 'class') {
      classFn(target as Function, context)
      return
    }

    if (context.kind === 'method' || context.kind === 'field') {
      memberFn(context)
      return
    }

    throw new ErrFetchyInvalidDecoratorTarget(decoratorName, 'a class, method, or field')
  }
}
