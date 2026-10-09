import './polyfill.js'

export type { Authenticator } from './authenticator.js'
export type { Transport, TransportFactory } from './transport.js'
export type { CallAdapter, CallAdapterFactory } from './call_adapter.js'
export type { Chain } from './chain.js'
export type { FetchyClientOptions } from './client.js'
export { FetchyClient } from './client.js'
export { FetchyBuilder, newClient } from './client_builder.js'
export * from './decorators/index.js'
export type { MethodSpec } from './decorators/registrar/index.js'
export {
  ErrFetchy,
  ErrFetchyClientNotBuilt,
  ErrFetchyEmptyClient,
  ErrFetchyFollowUpNotSent,
  ErrFetchyHTTP,
  ErrFetchyInvalidDecoratorTarget,
  ErrFetchyInvalidFormBody,
  ErrFetchyInvalidMultipartBody,
  ErrFetchyInvalidRoute,
  ErrFetchyMissingAPIDecorator,
  ErrFetchyMissingCallbackArgument,
  ErrFetchyMissingPathArgument,
  ErrFetchyTooManyAuthenticationAttempts,
} from './errors.js'
export { FetchyHeaders } from './headers.js'
export type { Interceptor, InterceptorFunction } from './interceptor.js'
export { toInterceptor } from './interceptor.js'
export type { ParamDescriptor } from './internal/param_descriptor.js'
export { MediaTypes } from './media_types.js'
export { noop } from './noop.js'
export { FetchyRequest } from './request.js'
export type { RequestBodyConverter } from './request_body_converter.js'
export {
  FormRequestBodyConverter,
  JSONRequestBodyConverter,
  MultipartRequestBodyConverter,
  RawRequestBodyConverter,
} from './request_body_converter.js'
export type { FetchyResponse } from './response.js'
export type { ResponseConverter } from './response_converter.js'
export { JSONResponseConverter, RawResponseConverter, TextResponseConverter } from './response_converter.js'
export type { ResponseHandler } from './response_handler.js'
export { DefaultResponseHandler, NoopResponseHandler } from './response_handler.js'
export type { RetryOptions } from './retry_options.js'
export { DEFAULT_RETRY_OPTIONS } from './retry_options.js'
