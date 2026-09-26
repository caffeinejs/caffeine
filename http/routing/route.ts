import { Ctor, Provider } from '@caffeinejs/di'
import type { CompiledGuard, ParameterPickOptions } from '@caffeinejs/std/framework'
import { FastifyRequest } from 'fastify'

import type { Context } from '../context.js'
import type { ErrorHandler } from '../error/handler.js'
import type { Guard } from '../guards/guard.js'
import { AuthzRouteService } from '../security/authz/index.js'
import type {
  BodyMode,
  RouteAuthz,
  RouteDetail,
  RouteGroupDetail,
  RouteInvoker,
  RouteValidationSchema,
} from './spec.js'

/** Error types mapped to the handler class that renders them, as declared by `@CatchWith`. */
export type CatchByMap = Map<Ctor<Error>, Provider<ErrorHandler<Error>>>

/**
 * A group of routes, compiled and ready to register.
 *
 * Nothing here says where the routes came from. A controller class, a programmatic registration and — later — a
 * functional route definition all produce this same shape, and the adapter cannot tell them apart.
 */
export interface RouteGroup<R = FastifyRequest> {
  path: string
  prefix?: string
  /** The controller's class name, or the name the group was given. Used for diagnostics and documentation. */
  name: string
  /**
   * The class that declared the group, when one did. Guards read it to reach `Symbol.metadata`, and the OpenAPI
   * generator names operations after it. A group with no class leaves it undefined.
   */
  target?: Function
  routes: Route<R>[]
  /**
   * A hook covering every route of the group, registered by the adapter exactly as given.
   *
   * Set by a source that needs per-request preparation — resolving the instance a `@Catch` method will be
   * invoked on, for one — and left undefined by every source that does not.
   */
  onRequest?: RouteGroupHook<R, unknown>
  /**
   * The group's own error handling, if it has any: a `@Catch` method on the controller, or whatever the
   * equivalent is for the source that built the group. Runs after the `@CatchWith` handlers of the route and
   * of the group, and returns {@link kErrorUnhandled} to pass the error on to the application-wide handler.
   */
  handleError?: RouteGroupErrorHandler<R>
  catchBy?: CatchByMap
  detail?: RouteGroupDetail

  /**
   * What installed the features whose plugins register inside this group's context, outermost first.
   *
   * A programmatic group lists its own router and every router it is nested under, so a plugin extended on a
   * parent reaches the groups below it the way `.with(...)` configuration does. A controller group lists the
   * class. Undefined when nothing scoped anything here.
   */
  scopes?: readonly object[]
}

/**
 * A group's own error handling. Returns {@link kErrorUnhandled} — not `undefined`, which is a legitimate
 * result meaning "responded, with no body" — when it declines the error.
 */
export type RouteGroupErrorHandler<R = FastifyRequest> = (
  req: R,
  ctx: Context,
  err: Error,
) => unknown | Promise<unknown>

/** Returned by a {@link RouteGroupErrorHandler} that does not handle the error. */
export const kErrorUnhandled: unique symbol = Symbol('caffeine.http.errorUnhandled')

export interface Route<R = FastifyRequest> {
  path: string
  method: string[]
  accept: string[]
  contentType: string
  parameters: ParameterPickOptions<R>[]
  /** Identity within the group: a controller's method key, or the name the route was given. */
  name: string | symbol
  /** Builds the function this route dispatches to. Called once, while the route is being registered. */
  dispatch: RouteDispatch<R, unknown>
  schema?: RouteValidationSchema
  bodyLimit?: number
  timeout?: number
  header?: Map<string, string | string[]>
  hasHeader?: boolean
  statusCode?: number
  /** How the raw body reaches the handler. Set by `@BodyAsBuffer` / `@BodyAsStream`. */
  bodyAs?: BodyMode
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  /**
   * What packages annotated this route with.
   *
   * Copied from the spec while the route compiles, so a plugin enriching it from an `onRoute` hook never
   * writes back into the authored spec. A GET route's automatic HEAD twin carries the *same* object, so an
   * enrichment is written once and both spellings observe it.
   */
  detail?: RouteDetail
  catchBy?: CatchByMap
  guards?: readonly CompiledGuard<Guard>[]
  authorization: RouteAuthorization
}

export interface RouteAuthorization {
  hasProtection: boolean
  /** Everything declared for the route, its groups included. Absent when no level declared anything. */
  options?: RouteAuthz
  authorizer?: AuthzRouteService

  /**
   * The scheme names that actually authenticate this route: the ones it named, or the application's default
   * authenticate scheme when it named none. Empty when no scheme is registered.
   *
   * Resolved while the route is compiled, so a reader — the OpenAPI generator, most of all — describes what
   * the route really requires without having to find the authentication feature and ask it what the default
   * is. It says nothing about whether the route is gated: {@link hasProtection} and
   * {@link RouteAuthz.allowAnonymous} answer that, and a route may name schemes without being gated.
   */
  schemes: readonly string[]
}

/**
 * The parameter compilers the adapter owns, handed to a route source so it can build its own dispatch without
 * knowing how arguments are picked out of a request.
 */
export interface RouteCompilers<REQ = unknown, RES = unknown> {
  /** Compiles the pickers around `fn`, returning the function the adapter installs as the route handler. */
  handler(parameters: ParameterPickOptions<REQ>[], fn: RouteInvoker): (req: REQ, res: RES) => unknown

  /** Compiles the pickers alone, for a source that resolves its target per request and invokes it itself. */
  args(parameters: ParameterPickOptions<REQ>[]): (req: REQ, res: RES) => unknown[] | Promise<unknown[]>
}

/**
 * Builds a route's dispatch function.
 *
 * Called once, while routes are being registered, and never again. A source with several invocation shapes —
 * a singleton instance, one resolved per request, a plain function — chooses between them here, so the request
 * path never branches on which source declared the route.
 */
export type RouteDispatch<REQ = unknown, RES = unknown> = (
  compilers: RouteCompilers<REQ, RES>,
) => (req: REQ, res: RES) => unknown

/**
 * A request hook covering every route of one group, supplied by the source that built it.
 *
 * Registered by the adapter exactly as given, so it costs what the equivalent hand-written hook costs.
 */
export type RouteGroupHook<REQ = unknown, RES = unknown> = (req: REQ, res: RES, done: (err?: Error) => void) => void
