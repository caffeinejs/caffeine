import type { Ctor, InjectionToken } from '@caffeinejs/di'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { ErrorHandlerRef } from '../error/error.js'
import { Guard } from '../guards/guard.js'
import type { RouteValidationSchema } from '../route.js'
import type { RouteInvoker } from './dispatch.js'

/**
 * A group of routes, as authored. Inert: it describes routes, it does not know how any of them is called.
 * Whatever produced it — the `@Controller` decorators, a programmatic registration — compiles it into a
 * {@link ../route.js#RouteGroup} through `compileRouteGroup`.
 */
export interface RouteGroupSpec<R> {
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
  errorHandlers?: Array<[Ctor<Error>, string | symbol]>
  catchBy?: ErrorHandlerRef[]
  guards?: InjectionToken<Guard>[]
  guardOptions?: Record<string | symbol, unknown>
}

export interface RouteSpec<R> {
  path: string
  method: string[]
  accept: string[]
  contentType: string
  parameters: ParameterPickOptions<R>[]
  /** Identity within the group: a controller's method key, or the name a route was given. */
  name: string | symbol
  /**
   * The function this route calls, for a source whose handler is a plain function. A source that resolves its
   * target some other way leaves this unset and supplies a dispatch instead.
   */
  handle?: RouteInvoker
  schema?: RouteValidationSchema
  bodyLimit?: number
  timeout?: number
  header?: Map<string, string | string[]>
  statusCode?: number
  authz?: RouteAuthzOptions
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
  catchBy?: ErrorHandlerRef[]
  guards?: InjectionToken<Guard>[]
  guardOptions?: Record<string | symbol, unknown>
}

export interface RouteAuthzOptions {
  allowAnonymous?: boolean
  policy?: string | string[]
  schemes?: string[]
  roles?: string[]
}
