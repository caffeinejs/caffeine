import type { ParameterPickOptions } from '@caffeinejs/application'
import { configureRoute } from './registrar/registrar.js'

export function Params(params: ParameterPickOptions<unknown>[]) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.parameters(params))
  }
}
