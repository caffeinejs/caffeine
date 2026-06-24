import { Binding, Key, Provider } from '@caffeinejs/core'
import { ParameterPickOptions } from './route.picker.js'

export interface RouteValidationSchema {
  params?: unknown
  querystring?: unknown
  headers?: unknown
  body?: unknown
  response?: unknown
}

export interface Route<R, SCHEMA extends RouteValidationSchema = RouteValidationSchema> {
  path: string
  method: string[]
  accept: string[]
  contentTypes: string[]
  parameters: ParameterPickOptions<R>[]
  header: Record<string, string | string[]>
  handler: string | symbol
  schema?: SCHEMA
  response: {
    status: number
    header: Record<string, string>
  }
}

export interface Router<R, SCHEMA extends RouteValidationSchema = RouteValidationSchema> {
  prefix: string
  routes: Route<R, SCHEMA>[]
  accept: string[]
  contentTypes: string[]
  header: Record<string, string | string[]>
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
}
