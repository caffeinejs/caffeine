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
  contentTypes: string[]
  parameters: ParameterPickOptions<R>[]
  header: Record<string, string | string[]>
  handler: string | symbol
  schema?: RouteValidationSchema
  bodyLimit?: number
  timeout?: number
  response: {
    status?: number
    header: Record<string, string>
  }
}

export interface Router<R> {
  path: string
  prefix?: string
  routes: Route<R>[]
  accept: string[]
  contentTypes: string[]
  header: Record<string, string | string[]>
  bodyLimit?: number
  timeout?: number
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
}
