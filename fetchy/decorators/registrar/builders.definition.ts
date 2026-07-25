import type { ParamDescriptor } from '../../internal/param_descriptor.js'

export interface ClassSpec {
  path: string
  headers: Headers
  requestType: string | undefined
  responseType: string | undefined
}

export interface MethodSpec {
  httpMethod: string
  path: string
  headers: Headers
  params: ParamDescriptor[]
  bodyIndex: number
  argLen: number
  formURLEncoded: boolean
  requestType: string | undefined
  responseType: string | undefined
}
