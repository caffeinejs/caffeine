import type { ResponseHandler } from '../response_handler.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Overrides the response handler used for a method (or every method, at class level) — the
 * default is `DefaultResponseHandler`, which throws `ErrFetchyHTTP` on a non-ok response.
 */
export function UseResponseHandler(handler: ResponseHandler) {
  return classOrMember(
    'UseResponseHandler',
    (_target, context) => configureClass(context, spec => spec.responseHandler(handler)),
    context => configureMethod(context, spec => spec.responseHandler(handler)),
  )
}
