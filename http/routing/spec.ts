import type { Ctor, InjectionToken } from '@caffeinejs/di'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { ErrorHandlerRef } from '../error/error.js'
import type { Guard } from '../guards/guard.js'
import type { RouteValidationSchema } from '../route.js'
import type { RouteDetail, RouteGroupDetail } from './detail.js'
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
  detail?: RouteGroupDetail
  errorHandlers?: Array<[Ctor<Error>, string | symbol]>
  catchBy?: ErrorHandlerRef[]
  guards?: InjectionToken<Guard>[]
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
  /** How the raw body reaches the handler. Set by `@BodyAsBuffer` / `@BodyAsStream`. */
  bodyAs?: BodyMode
  authz?: RouteAuthzOptions
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  detail?: RouteDetail
  catchBy?: ErrorHandlerRef[]
  guards?: InjectionToken<Guard>[]
}

/**
 * How a route's raw body is delivered: as a `Buffer`, or as a stream left unparsed.
 *
 * Absent means the ordinary content-type parsers apply. This changes what the handler receives, so it is a
 * field of its own rather than something carried in {@link RouteDetail}, which is descriptive only.
 */
export type BodyMode = 'buffer' | 'stream'

export interface RouteAuthzOptions {
  allowAnonymous?: boolean
  policy?: string | string[]
  schemes?: string[]
  roles?: string[]
}
