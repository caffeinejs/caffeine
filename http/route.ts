import type { ParameterPickOptions } from '@caffeinejs/application'
import { Binding, Key, Provider } from '@caffeinejs/core'
import { AuthzRouteService } from './security/authz/authz_route_service.js'
import { RouteAuthzOptions } from './decorators/registrar/routing.definition.js'

export interface Router<R> {
  path: string
  prefix?: string
  routes: Route<R>[]
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
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
  authorization: RouteAuthorization
}

export interface RouteAuthorization {
  enabled: boolean
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
