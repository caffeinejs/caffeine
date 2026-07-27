import type { ParamDescriptor } from '../../internal/param_descriptor.js'
import type { RequestBodyConverter } from '../../request_body_converter.js'
import type { ResponseConverter } from '../../response_converter.js'
import type { ResponseHandler } from '../../response_handler.js'
import type { RetryOptions } from '../../retry_options.js'

export interface ClassSpec {
  path: string
  headers: Headers
  requestType: string | undefined
  responseConverter: ResponseConverter | undefined
  requestBodyConverter: RequestBodyConverter | undefined
  responseHandler: ResponseHandler | undefined
  retry: RetryOptions | undefined
}

export interface MethodSpec {
  httpMethod: string
  path: string
  headers: Headers
  params: ParamDescriptor[]
  formURLEncoded: boolean
  requestType: string | undefined
  responseConverter: ResponseConverter | undefined
  requestBodyConverter: RequestBodyConverter | undefined
  responseHandler: ResponseHandler | undefined
  kind: 'method' | 'field'
  callback: boolean
  retry: RetryOptions | undefined
  noRetry: boolean
}
