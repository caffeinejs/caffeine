import type { Ctor, InjectionToken } from '@caffeinejs/di'
import type { AnySchema } from '@caffeinejs/std'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { ErrorHandlerRef } from '../error/handler.js'
import type { Guard } from '../guards/guard.js'

/**
 * A group of routes, as authored. Inert: it describes routes, it does not know how any of them is called.
 * Whatever produced it — the `@Controller` decorators, a programmatic registration — compiles it into a
 * {@link ./route.js#RouteGroup} through `compileRouteGroup`.
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
  authz?: RouteAuthz
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
  authz?: RouteAuthz
  config?: Map<string, unknown>
  options?: Map<string, unknown>
  detail?: RouteDetail
  catchBy?: ErrorHandlerRef[]
  guards?: InjectionToken<Guard>[]
}

/** The function a route ultimately calls, with the picked arguments spread into it. */
export type RouteInvoker = (...args: unknown[]) => unknown

/**
 * The validation contract of a route, as authored. Every slot takes the `$t` dialect (recommended) or any Standard
 * Schema that converts to JSON Schema.
 *
 * This is the authoring shape, not the runtime one: each slot is compiled to JSON Schema once, while routes are
 * being registered, and Fastify's Ajv does all request-time validation. See `../schema/compile_route_schema.ts` for
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

/**
 * How a route's raw body is delivered: as a `Buffer`, or as a stream left unparsed.
 *
 * Absent means the ordinary content-type parsers apply. This changes what the handler receives, so it is a
 * field of its own rather than something carried in {@link RouteDetail}, which is descriptive only.
 */
export type BodyMode = 'buffer' | 'stream'

/** One authorization declaration, as `@Authorize`, `@Roles`, `@AllowAnonymous` or `.authorize(...)` hands it over. */
export interface RouteAuthzOptions {
  allowAnonymous?: boolean
  policy?: string | string[]
  schemes?: string[]
  roles?: string[]
}

/**
 * What a group or a route declared about authorization: every {@link RouteAuthzOptions} made on it, folded into one.
 *
 * Declarations add up and none replaces another. A route may carry several — `@Roles` next to `@Authorize`, a
 * chain calling `.authorize(...)` twice — and a route sits inside a group that may sit inside others. `foldAuthz`
 * combines the declarations of one level and `mergeAuthz` combines levels.
 */
export interface RouteAuthz {
  /**
   * The level was declared public. It opens what declares nothing below it, and a more specific level that
   * declares protection of its own is protected all the same.
   */
  allowAnonymous: boolean
  /**
   * A declaration named no requirement of its own — a bare `@Authorize()`, or one naming only schemes — which is
   * what asks for the policy the application set as the decorator's default.
   */
  defaultPolicy: boolean
  /** Named policies. Every one of them has to pass. */
  policies: readonly string[]
  /** One entry per `roles` declaration: any role of an entry satisfies that entry, and every entry has to be satisfied. */
  roleGroups: ReadonlyArray<readonly string[]>
  schemes?: readonly string[]
}

/**
 * What a package annotates a route with, keyed by a namespace that package owns.
 *
 * Empty here on purpose. A package that annotates routes augments this interface with its own field, so a
 * reader gets the real type instead of an `unknown` it has to cast:
 *
 * ```ts
 * declare module '@caffeinejs/http' {
 *   interface RouteDetail {
 *     openapi?: OperationDetail
 *   }
 * }
 * ```
 *
 * Routing carries the value through untouched, which is what lets a package describe a route without this
 * one knowing the package exists.
 */
export interface RouteDetail {
  /** The one namespace this package owns. See {@link RouteGroupDetail.http}. */
  http?: {
    /**
     * The route is served by the framework or a feature on the application's behalf and is not part of the
     * application's API: a single-page application's shell, for one. A reader that describes the
     * application's routes skips it.
     */
    internal?: boolean
  }
}

/**
 * The group-level counterpart of {@link RouteDetail}.
 *
 * Group detail describes the group itself and is never merged down into its routes — a reader that wants both
 * reads the two levels separately. A group nested inside another does inherit, which is the one merge
 * `inheritGroupSpec` performs.
 */
export interface RouteGroupDetail {
  /**
   * The one namespace this package owns. `internal` marks a group the framework or a feature registered on
   * the application's behalf, which a reader describing the application's API skips; `@caffeinejs/openapi`
   * honours it the way it honours its own `openapi.hidden`.
   */
  http?: {
    internal?: boolean
  }
}
