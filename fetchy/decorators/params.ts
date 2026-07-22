import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { methodMeta } from '../metadata.js'
import type { ApiParameterSpec } from './params/api_parameter_spec.js'

/**
 * Binds a method's arguments to request parts, in declaration order. TC39 has no parameter
 * decorators, so this single method decorator accepts an ordered array of parameter specs
 * (`Param`, `Query`, `QueryName`, `Header`, `Body`, `Field`, `SignalParam`) instead.
 */
export function Params(specs: ApiParameterSpec[]) {
  return function (_value: Function, context: ClassMethodDecoratorContext): void {
    if (context.kind !== 'method') {
      throw new ErrFetchyInvalidDecoratorTarget('Params', 'a method')
    }

    const meta = methodMeta(context.metadata, context.name)

    specs.forEach((spec, index) => spec.apply({ meta, index }))
    meta.argLen = specs.length
  }
}
