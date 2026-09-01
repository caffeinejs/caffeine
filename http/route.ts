import { Ctor, Provider } from '@caffeinejs/di'
import type { AnySchema } from '@caffeinejs/std'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import { FastifyRequest } from 'fastify'
import type { Context } from './context.js'
import type { ErrorHandler } from './error/error.js'
import { AuthzRouteService } from './security/authz/index.js'
import { RouteAuthzOptions } from './routing/spec.js'
import type { RouteDispatch, RouteGroupHook } from './routing/dispatch.js'
import type { CompiledGuard } from './guards/compile.js'

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
  extras?: Map<symbol, unknown>
}

/**
 * A group's own error handling. Returns {@link kErrorUnhandled} — not `undefined`, which is a legitimate
 * result meaning "responded, with no body" — when it declines the error.
 */
export type RouteGroupErrorHandler<R = FastifyRequest>
  = (req: R, ctx: Context, err: Error) => unknown | Promise<unknown>

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
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  extras?: Map<symbol, unknown>
  catchBy?: CatchByMap
  guards?: CompiledGuard[]
  guardOptions?: Record<string | symbol, unknown>
  authorization: RouteAuthorization
}

export interface RouteAuthorization {
  hasProtection: boolean
  options?: RouteAuthzOptions
  authorizer?: AuthzRouteService
}

/**
 * The validation contract of a route, as authored. Every slot takes the `$t` dialect (recommended) or any Standard
 * Schema that converts to JSON Schema.
 *
 * This is the authoring shape, not the runtime one: each slot is compiled to JSON Schema once, while routes are
 * being registered, and Fastify's Ajv does all request-time validation. See `./schema/compile_route_schema.ts` for
 * the compilation and the per-slot strictness policy.
 */
export interface RouteValidationSchema {
  params?: AnySchema
  querystring?: AnySchema
  headers?: AnySchema
  body?: AnySchema
  /**
   * Response schemas keyed by status code, as Fastify requires: `{ 200: $t.Object({ ... }), '4xx': ErrorBody }`.
   *
   * Beware that a response schema *serializes*, it does not validate. Fastify hands it to fast-json-stringify,
   * which emits only the declared properties — a handler returning a non-conforming object is not rejected, its
   * extra fields are simply omitted.
   */
  response?: Record<number | string, AnySchema>
}
