import type { Container, Ctor, InjectionToken } from '@caffeinejs/di'
import type { FastifyInstance } from 'fastify'

import type { Context } from '../context.js'
import type { ActionResult } from '../response.js'
import type { RouteGroup } from '../route.js'
import type { Services } from '../service.js'

/**
 * Runs the rest of the pipeline and returns whatever it produced.
 *
 * In the `handler` group that value is the controller's own return value, so a middleware may inspect it,
 * replace it, or wrap it. In a hook group there is no handler to reach, so it produces `undefined` once the
 * remaining middlewares of that group have run.
 *
 * `await next()` is always correct and is what most middlewares should write. The return type is not a
 * promise because a chain of synchronous middlewares does not create one — awaiting a plain value is free,
 * whereas manufacturing a promise per request is not.
 *
 * Calling it twice in one middleware is a bug, not a fallback, and throws.
 */
export type Next = () => ActionResult

/**
 * The functional form of a middleware. Return without calling `next` to short-circuit the pipeline.
 *
 * `V` names what the middleware reads and writes through `ctx.state`, and `C` what `ctx.config` carries:
 *
 * ```ts
 * const tenancy: MiddlewareFn<{ tenant: Tenant }> = (ctx, next) => {
 *   ctx.state.set('tenant', resolve(ctx))
 *   return next()
 * }
 * ```
 */
export type MiddlewareFn<V = Record<never, never>, C = Record<never, never>> = (
  ctx: Context<V, C>,
  next: Next,
) => ActionResult

/**
 * The class form of a middleware, which is what a middleware with dependencies should be: bind it in the
 * container and register it by class or key, and the container injects it.
 *
 * ```ts
 * class Envelope extends Middleware {
 *   async handle(ctx: Context, next: Next) {
 *     return { data: await next() }
 *   }
 * }
 *
 * app.use(Envelope)
 * ```
 */
export abstract class Middleware<V = Record<never, never>, C = Record<never, never>> {
  /**
   * Ran once at start-up, before any request. Resolve singletons here, validate the configuration here, and
   * throw here — a middleware that cannot work is a start-up failure, not a per-request one.
   *
   * Skipped for a middleware whose dependency graph reaches request scope: there is no instance to call it
   * on until a request exists.
   */
  setup?(ctx: MiddlewareSetupContext): void | Promise<void>

  abstract handle(ctx: Context<V, C>, next: Next): ActionResult
}

/** What a middleware is given at start-up: the whole application, resolved. */
export interface MiddlewareSetupContext {
  server: FastifyInstance
  container: Container
  services: Services
  routeGroups: RouteGroup<any>[]
}

/**
 * Where a middleware runs.
 *
 * `handler` (the default) wraps the controller dispatch, so `next()` returns the handler's result and the
 * middleware can replace it. It covers routes the application's controllers declare — not the ones the
 * framework registers for itself (health probes, the OIDC callback, static files, views), which have no
 * controller to wrap.
 *
 * The rest are Fastify's own request-lifecycle hooks, registered on the server. They cover *every* route,
 * they run in Fastify's order rather than registration order, and their `next()` cannot reach the handler.
 * Use one when the middleware must act before the body is parsed or validated — authentication does, so
 * that an unauthenticated caller is answered 401 rather than a 400 describing the route's schema.
 */
export type MiddlewareHook = 'handler' | 'onRequest' | 'preParsing' | 'preValidation' | 'preHandler'

export const MIDDLEWARE_HOOKS: readonly MiddlewareHook[] = [
  'handler',
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
]

/** Anything `use()` accepts: a function, an instance, a class, or a container key. */
export type MiddlewareRef<V = Record<never, never>, C = Record<never, never>> =
  | MiddlewareFn<V, C>
  | Middleware<V, C>
  | Ctor<Middleware<V, C>>
  | InjectionToken

/** Whether `ref` is a middleware class rather than a plain middleware function. */
export function isMiddlewareClass(ref: unknown): ref is Ctor<Middleware> {
  return (
    typeof ref === 'function' && typeof (ref as { prototype?: { handle?: unknown } }).prototype?.handle === 'function'
  )
}

/** Whether `ref` is an already-constructed middleware. */
export function isMiddlewareInstance(ref: unknown): ref is Middleware {
  return typeof ref === 'object' && ref !== null && typeof (ref as Middleware).handle === 'function'
}
