import { Injection, InjectionDescriptor } from '../../injection.js'
import { Ctor } from '../../types.js'

export function normalizeInjection(dep: Injection): InjectionDescriptor {
  return typeof dep === 'object' ? (dep as InjectionDescriptor) : { key: dep }
}

export function normalizeInjections(deps: Injection[]): InjectionDescriptor[] {
  return deps.map(normalizeInjection)
}

export function defineClassOrMemberDecorator(
  classFn: (target: Ctor, ctx: ClassDecoratorContext) => void,
  classMemberFn: (ctx: DecoratorContext) => void,
): (target: Function | object, context: DecoratorContext) => void {
  return (target: Function | object, context: DecoratorContext) => {
    if (context.kind === 'class') {
      classFn(target as Ctor, context as ClassDecoratorContext)
    } else {
      classMemberFn(context)
    }
  }
}
