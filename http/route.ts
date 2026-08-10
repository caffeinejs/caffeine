import { Binding, Ctor, Key, Provider } from '@caffeinejs/di'
import type { ParameterPickOptions } from './route_picker.js'
import type { ErrorHandler } from './error/error.js'
import { AuthzRouteService } from './security/authz/index.js'
import { RouteAuthzOptions } from './decorators/registrar/routing.definition.js'

/** Error types mapped to the handler class that renders them, as declared by `@CatchBy`. */
export type CatchByMap = Map<Ctor<Error>, Provider<ErrorHandler<Error>>>

export interface Router<R> {
  path: string
  prefix?: string
  routes: Route<R>[]
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
  errorHandlers?: Map<Ctor<Error>, string | symbol>
  catchBy?: CatchByMap
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
  hasHeader?: boolean
  statusCode?: number
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
  catchBy?: CatchByMap
  authorization: RouteAuthorization
}

export interface RouteAuthorization {
  hasProtection: boolean
  options?: RouteAuthzOptions
  authorizer?: AuthzRouteService
}

export interface RouteValidationSchema {
  params?: unknown
  querystring?: unknown
  headers?: unknown
  body?: unknown
  response?: unknown
}
