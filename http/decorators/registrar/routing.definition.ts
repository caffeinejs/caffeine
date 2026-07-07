import type { ParameterPickOptions } from '@caffeinejs/application'
import { RouteValidationSchema } from '../../route.js'

export interface RouterSpec<R> {
  path: string
  prefix?: string
  routes: RouteSpec<R>[]
  accept: string[]
  contentType: string
  header?: Map<string, string | string[]>
  bodyLimit?: number
  timeout?: number
  authz?: RouteAuthzOptions
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
}

export interface RouteSpec<R> {
  path: string
  method: string[]
  accept: string[]
  contentType: string
  parameters: ParameterPickOptions<R>[]
  handler: string | symbol
  schema?: RouteValidationSchema
  bodyLimit?: number
  timeout?: number
  header?: Map<string, string | string[]>
  statusCode?: number
  authz?: RouteAuthzOptions
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
}

export interface RouteAuthzOptions {
  allowAnonymous?: boolean
  policy?: string | string[]
  schemes?: string[]
  roles?: string[]
}
