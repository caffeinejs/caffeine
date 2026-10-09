import type { ParamDescriptor } from '../../internal/param_descriptor.js'
import type { RequestBodyConverter } from '../../request_body_converter.js'
import type { ResponseConverter } from '../../response_converter.js'
import type { ResponseHandler } from '../../response_handler.js'
import type { RetryOptions } from '../../retry_options.js'

export interface ClassSpec {
  path: string | undefined
  headers: Headers
  formURLEncoded: boolean
  multipart: boolean
  responseConverter: ResponseConverter | undefined
  requestBodyConverter: RequestBodyConverter | undefined
  responseHandler: ResponseHandler | undefined
  retry: RetryOptions | undefined
}

/**
 * The configuration of one operation, as an interceptor reads it through `chain.meta()`.
 *
 * One object serves every call to the operation, on every client of its class, so it is read-only.
 */
export interface MethodSpec {
  /** The member that declares the operation, as written in the class, such as `getUser`. */
  readonly name: string
  readonly httpMethod: string
  readonly path: string
  readonly headers: Headers
  readonly params: readonly ParamDescriptor[]
  readonly formURLEncoded: boolean
  readonly multipart: boolean
  readonly responseConverter: ResponseConverter | undefined
  readonly requestBodyConverter: RequestBodyConverter | undefined
  readonly responseHandler: ResponseHandler | undefined
  readonly callback: boolean
  readonly retry: RetryOptions | undefined
  readonly noRetry: boolean
}
