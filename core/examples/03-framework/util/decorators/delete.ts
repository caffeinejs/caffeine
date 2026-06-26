import { Tag } from '@caffeinejs/core'

export function Delete(path: string) {
  return function (target: Function, context: ClassMethodDecoratorContext): void {
    Tag(Symbol.for('controller:routes'), [{ handler: context.name, path, method: 'delete' }])(target, context)
  }
}
