import type { RouteBuilder, RouteGroupBuilder } from '../builder.js'

/**
 * A unit of route configuration, written by whoever owns the feature rather than by the router.
 *
 * This is the same function a decorator already passes to `configureRoute` — `spec => spec.extras(kOperation, d)`
 * and nothing more — so a package can back its decorator and its programmatic form with one implementation, and
 * the two cannot drift. `@caffeinejs/openapi` annotating an operation is the case it exists for.
 *
 * `path`, `method`, `parameters` and the handler are the router's, not an extension's: whatever an extension writes
 * to those is replaced while the route is being built. Everything else on the builder is fair game.
 *
 * ```ts
 * export function operation(detail: OperationDetail): RouteExtension {
 *   return route => route.extras(kOperation, detail)
 * }
 * ```
 */
export type RouteExtension = (route: RouteBuilder) => void

/**
 * A unit of group configuration. The group-level counterpart of {@link RouteExtension}, and what a package writes
 * when its feature covers every route of a group rather than one.
 */
export type RouteGroupExtension = (group: RouteGroupBuilder) => void

/**
 * An extension that applies at either level.
 *
 * Written with a union parameter — `(target: RouteBuilder | RouteGroupBuilder) => void` satisfies both sides of the
 * intersection — so one function serves a feature that a route and a group can each declare.
 */
export type AnyRouteExtension = RouteExtension & RouteGroupExtension
