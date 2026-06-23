import { ParameterPickOptions } from '../route.picker.js'
import { configureRoute } from './_registrar.js'

export function Params(params: ParameterPickOptions<unknown>[]) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.parameters(params))
  }
}
