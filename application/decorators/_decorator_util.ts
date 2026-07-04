export function defineClassOrMemberDecorator(
  classFn: (target: Function, ctx: ClassDecoratorContext) => void,
  classMemberFn: (ctx: ClassMemberDecoratorContext) => void,
): (target: Function | object, context: ClassDecoratorContext | ClassMemberDecoratorContext) => void {
  return (target: Function | object, context: ClassDecoratorContext | ClassMemberDecoratorContext) => {
    if (context.kind === 'class') {
      classFn(target as Function, context as ClassDecoratorContext)
    } else {
      classMemberFn(context)
    }
  }
}
