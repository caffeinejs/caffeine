import type { RequestBodyConverter } from '../request_body_converter.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Overrides the request body converter used for a method's `@Body()` value (or every method, at
 * class level) — the default is `JSONRequestBodyConverter` when unset.
 */
export function UseRequestBodyConverter(converter: RequestBodyConverter) {
  return classOrMember(
    'UseRequestBodyConverter',
    (_target, context) => configureClass(context, spec => spec.requestBodyConverter(converter)),
    context => configureMethod(context, spec => spec.requestBodyConverter(converter)),
  )
}
