import type { ParamDescriptor } from '../../internal/param_descriptor.js'
import type { ResponseConverter } from '../../response_converter.js'

export interface ClassSpec {
  path: string
  headers: Headers
  requestType: string | undefined
  responseConverter: ResponseConverter | undefined
}

export interface MethodSpec {
  httpMethod: string
  path: string
  headers: Headers
  params: ParamDescriptor[]
  formURLEncoded: boolean
  requestType: string | undefined
  responseConverter: ResponseConverter | undefined
  kind: 'method' | 'field'
}
