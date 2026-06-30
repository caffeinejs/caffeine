import { Binding, Key, Provider } from '@caffeinejs/core'
import { ParameterPickOptions } from './route.picker.js'

export interface RouteValidationSchema {
  params?: unknown
  querystring?: unknown
  headers?: unknown
  body?: unknown
  response?: unknown
}

export interface Route<R> {
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
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
}

export interface Router<R> {
  path: string
  prefix?: string
  routes: Route<R>[]
  accept: string[]
  contentType: string
  header?: Map<string, string | string[]>
  bodyLimit?: number
  timeout?: number
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
}
