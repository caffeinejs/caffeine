import { Tag } from '@caffeine/core/decorators'

export function Post(path: string) {
  return function (target: Function, context: ClassMethodDecoratorContext): void {
    Tag(Symbol.for('controller:routes'), [{ handler: context.name, path, method: 'post' }])(target, context)
  }
}
