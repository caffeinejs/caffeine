import { type FastifyRequest, type RouteOptions } from 'fastify'

import { type CatchByMap, type Route, type RouteGroup } from './route.js'
import { type AuthzRouteService } from './security/authz/route_service.js'

/** What the authentication gate has to know about the route a request matched. */
export interface GatedRoute {
  schemes?: readonly string[]
  allowAnonymous: boolean
  authorizer?: AuthzRouteService
}

/** What Caffeine compiled for a route, as the handler and every `onRoute` reader see it. */
export interface CompiledRouteMetadata<R = FastifyRequest> {
  /**
   * The compiled route: schema, authorization, constraints, detail. A GET route's automatic HEAD twin
   * carries the same object, so an enrichment written to `detail` is observed by both spellings.
   */
  route: Route<R>
  /** The group the route was compiled in: its path, prefix, name, target and detail. */
  group: RouteGroup<R>
  hasStatus: boolean
  status: number
  hasContentType: boolean
  contentType: string
  hasHeader: boolean
  header: Array<[string, string | string[]]>
  catchBy?: CatchByMap
}

/**
 * What Caffeine puts on a route's Fastify config, under `$caffeine`.
 *
 * The adapter stamps one onto every route its server registers, so a plugin's `onRoute` hook reads
 * {@link CaffeineRouteConfig.compiled} — not `$caffeine` itself — to tell a route the framework compiled from one
 * registered straight on Fastify.
 *
 * It is absent on the not-found context, which Fastify builds directly rather than as a route, so no `onRoute`
 * hook ever reaches it. Read it with `?.`: `$caffeine` is an invariant of route registration, not of every
 * request.
 */
export interface CaffeineRouteConfig<R = FastifyRequest> {
  /** What Caffeine compiled. Absent on a route registered straight on Fastify. */
  compiled?: CompiledRouteMetadata<R>

  /**
   * The gate returns before authenticating, so no principal is established.
   *
   * See {@link authenticationExempt}.
   */
  skipAuthentication: boolean

  /**
   * What the route declared about authentication and authorization, carried here because the authentication
   * hook is added once for the whole server and only learns which route it is on at request time.
   *
   * Absent when nothing declared anything, which is the case the application's fallback policy answers.
   */
  auth?: GatedRoute
}

/**
 * Route config for a route the authentication gate must leave alone.
 *
 * For a route registered straight on the server that has to answer before anyone is signed in, whatever the
 * application's fallback policy says — a health probe, the callback an identity provider redirects to. A
 * compiled route never needs it: `@AllowAnonymous` says the same thing.
 *
 * No principal is established for such a route either, so its handler must not read `ctx.user`.
 *
 * Reach for {@link exemptFromAuthentication} instead where the route is registered by somebody else and an
 * `onRoute` hook is all there is.
 *
 * @example
 * ```ts
 * instance.get('/metrics', { config: authenticationExempt() }, handler)
 * ```
 */
export function authenticationExempt(): { $caffeine: CaffeineRouteConfig } {
  // A fresh object every call: the adapter and `@caffeinejs/static` both stamp in place, and Fastify hands a
  // GET route's automatic HEAD twin the very same config object.
  return { $caffeine: { skipAuthentication: true } }
}

/**
 * Marks a route the authentication gate must leave alone, from an `onRoute` hook.
 *
 * For a plugin that does not register the route itself and can only reach it as it registers — `@fastify/static`
 * forwards no route config of its own. Where the caller owns the registration, hand {@link authenticationExempt}
 * to `config` instead.
 */
export function exemptFromAuthentication(route: RouteOptions): void {
  const config = (route.config ??= {})
  const meta = (config.$caffeine ??= { skipAuthentication: false })

  meta.skipAuthentication = true
}
