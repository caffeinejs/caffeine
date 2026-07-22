import { MediaTypes } from '../media_types.js'
import { classMeta, methodMeta } from '../metadata.js'
import { classOrMethod } from './_decorator_util.js'

/**
 * Marks a method's (or every method's, at class level) request body as
 * `application/x-www-form-urlencoded`, to be populated from `@Field()` parameters.
 */
export function FormUrlEncoded() {
  return classOrMethod(
    'FormUrlEncoded',
    (_target, context) => {
      const meta = classMeta(context.metadata)
      meta.requestType = 'form'
      meta.headers.append('content-type', MediaTypes.FORM_URL_ENCODED)
    },
    context => {
      const meta = methodMeta(context.metadata, context.name)
      meta.formUrlEncoded = true
      meta.requestType = 'form'
      meta.headers.append('content-type', MediaTypes.FORM_URL_ENCODED)
    },
  )
}
