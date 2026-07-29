import { Tag } from '@caffeinejs/di'

export function Get(path: string) {
  return function (target: Function, context: ClassMethodDecoratorContext): void {
    Tag(Symbol.for('controller:routes'), [{ handler: context.name, path, method: 'get' }])(target, context)
  }
}
