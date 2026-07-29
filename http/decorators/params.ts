import type { ParameterPickOptions } from '../route_picker.js'
import { configureRoute } from './registrar/registrar.js'

export function Params(params: ParameterPickOptions<unknown>[]) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.parameters(params))
  }
}
