import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureMethod } from './registrar/registrar.js'
import type { APIParameterSpec } from './params/api_parameter_spec.js'

/**
 * Binds a method's arguments to request parts, in declaration order. TC39 has no parameter
 * decorators, so this single method decorator accepts an ordered array of parameter specs
 * (`Param`, `Query`, `QueryName`, `Header`, `Body`, `Field`, `SignalParam`) instead.
 */
export function Params(specs: APIParameterSpec[]) {
  return function (_value: Function, context: ClassMethodDecoratorContext): void {
    if (context.kind !== 'method') {
      throw new ErrFetchyInvalidDecoratorTarget('Params', 'a method')
    }

    configureMethod(context, spec => {
      specs.forEach((s, index) => s.apply({ spec, index }))
      spec.argLen(specs.length)
    })
  }
}
