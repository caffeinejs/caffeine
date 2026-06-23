import { Tag } from '@caffeinejs/core/decorators'

export function Put(path: string) {
  return function (target: Function, context: ClassMethodDecoratorContext): void {
    Tag(Symbol.for('controller:routes'), [{ handler: context.name, path, method: 'put' }])(target, context)
  }
}
