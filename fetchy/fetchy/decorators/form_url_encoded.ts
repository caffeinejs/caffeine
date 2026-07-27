import { MediaTypes } from '../media_types.js'
import { configureClass, configureMethod } from './registrar/registrar.js'
import { classOrMember } from './_decorator_util.js'

/**
 * Marks a method's (or every method's, at class level) request body as
 * `application/x-www-form-urlencoded`, to be populated from `@Field()` parameters.
 */
export function FormURLEncoded() {
  return classOrMember(
    'FormURLEncoded',
    (_target, context) => configureClass(context, spec => {
      spec.requestType('form')
      spec.header('content-type', MediaTypes.FORM_URL_ENCODED)
    }),
    context => configureMethod(context, spec => {
      spec.formURLEncoded()
      spec.requestType('form')
      spec.header('content-type', MediaTypes.FORM_URL_ENCODED)
    }),
  )
}
