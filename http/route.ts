import { Binding, Ctor, Key, Provider } from '@caffeinejs/di'
import type { AnySchema } from '@caffeinejs/std'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import { FastifyRequest } from 'fastify'
import type { ErrorHandler } from './error/error.js'
import { AuthzRouteService } from './security/authz/index.js'
import { RouteAuthzOptions } from './decorators/registrar/routing.js'
import type { CompiledGuard } from './guards/compile.js'

/** Error types mapped to the handler class that renders them, as declared by `@CatchWith`. */
export type CatchByMap = Map<Ctor<Error>, Provider<ErrorHandler<Error>>>

export interface Router<R = FastifyRequest> {
  path: string
  prefix?: string
  routes: Route<R>[]
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
  errorHandlers?: Map<Ctor<Error>, string | symbol>
  catchBy?: CatchByMap
  extras?: Map<symbol, unknown>
}

export interface Route<R = FastifyRequest> {
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
