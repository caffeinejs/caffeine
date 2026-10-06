import { MediaTypes } from '../media_types.js'
import { FormRequestBodyConverter } from '../request_body_converter.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Marks a method's (or every method's, at class level) request body as
 * `application/x-www-form-urlencoded`, populated from `@Field()` parameters or encoded from a
 * `@Body()` value with {@link FormRequestBodyConverter}. A `@UseRequestBodyConverter()` listed
 * above it on the same target replaces that converter.
 */
export function FormURLEncoded() {
  return classOrMember(
    'FormURLEncoded',
    (_target, context) =>
      configureClass(context, spec => {
        spec.formURLEncoded()
        spec.requestBodyConverter(FormRequestBodyConverter)
        spec.header('content-type', MediaTypes.FORM_URL_ENCODED)
      }),
    context =>
      configureMethod(context, spec => {
        spec.formURLEncoded()
        spec.requestBodyConverter(FormRequestBodyConverter)
        spec.header('content-type', MediaTypes.FORM_URL_ENCODED)
      }),
  )
}
