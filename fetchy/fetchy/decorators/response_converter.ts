import type { ResponseConverter as ResponseConverterInstance } from '../response_converter.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Overrides the response converter used for a method (or every method, at class level), taking
 * precedence over the client-wide default set via `FetchyBuilder.responseConverter()`.
 */
export function UseResponseConverter(converter: ResponseConverterInstance) {
  return classOrMember(
    'UseResponseConverter',
    (_target, context) => configureClass(context, spec => spec.responseConverter(converter)),
    context => configureMethod(context, spec => spec.responseConverter(converter)),
  )
}
