import { configureRoute } from './_registrar.js'

export function Schema(schema: unknown) {
  return function (_target: Function, context: ClassMemberDecoratorContext): void {
    configureRoute(context, spec => spec.schema(schema))
  }
}
