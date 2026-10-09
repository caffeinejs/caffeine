import { MultipartRequestBodyConverter } from '../request_body_converter.js'
import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Sends a method's (or every method's, at class level) request body as `multipart/form-data`: a
 * `FormData` built from `Part()` parameters, or converted from a `@Body()` value with
 * {@link MultipartRequestBodyConverter}. A `@UseRequestBodyConverter()` listed above it on the same
 * target replaces that converter.
 *
 * The transport writes the part boundary into `content-type` and the encoded size into
 * `content-length`, so a content-type or content-length declared on the class or the method is not
 * sent with a `FormData` body. A `Header('content-type')` or `Header('content-length')` parameter
 * is refused when the client is built, on an operation with `Part()` parameters or a `@Body()` that
 * {@link MultipartRequestBodyConverter} converts.
 *
 * On Node, `fetch` reads every part into memory before it sends the request. The transport of
 * `@caffeinejs/fetchy-undici` streams each part as the connection takes it.
 */
export function Multipart() {
  return classOrMember(
    'Multipart',
    (_target, context) =>
      configureClass(context, spec => {
        spec.multipart()
        spec.requestBodyConverter(MultipartRequestBodyConverter)
      }),
    context =>
      configureMethod(context, spec => {
        spec.multipart()
        spec.requestBodyConverter(MultipartRequestBodyConverter)
      }),
  )
}
