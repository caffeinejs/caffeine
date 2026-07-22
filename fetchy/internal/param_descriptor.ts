export interface PathParamDescriptor {
  kind: 'path'
  key: string
  index: number
}

export interface QueryParamDescriptor {
  kind: 'query'
  key: string
  index: number
}

export interface QueryNameParamDescriptor {
  kind: 'query-name'
  index: number
}

export interface HeaderParamDescriptor {
  kind: 'header'
  key: string
  index: number
}

export interface BodyParamDescriptor {
  kind: 'body'
  index: number
}

export interface FormFieldParamDescriptor {
  kind: 'form-field'
  key: string
  index: number
}

export interface SignalParamDescriptor {
  kind: 'signal'
  index: number
}

export type ParamDescriptor
  = | PathParamDescriptor
    | QueryParamDescriptor
    | QueryNameParamDescriptor
    | HeaderParamDescriptor
    | BodyParamDescriptor
    | FormFieldParamDescriptor
    | SignalParamDescriptor
