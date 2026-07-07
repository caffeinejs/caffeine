import type { RouteValidationSchema } from '../route.js'
import { configureRoute } from './registrar/registrar.js'

export function Schema<S extends RouteValidationSchema>(schema: S) {
  return function (_target: Function, context: ClassMemberDecoratorContext): void {
    configureRoute(context, spec => spec.schema(schema))
  }
}
