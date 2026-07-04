import { configureRoute } from '@caffeinejs/application'
import { configureRouter } from '@caffeinejs/application/decorators/registrar'

export function Config(config: Record<string | symbol, unknown>) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => {
        for (const [key, value] of Object.entries(config)) {
          spec.config(key, value)
        }
      })
    } else {
      configureRoute(context, spec => {
        for (const [key, value] of Object.entries(config)) {
          spec.config(key, value)
        }
      })
    }
  }
}
