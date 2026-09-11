import type { Ctor, InjectionToken } from '@caffeinejs/di'

import type { Context } from '../context.js'

/**
 * Continues the rest of the pipeline, or fails it.
 *
 * `next()` runs the remaining middlewares of this group, and the terminal after them — the controller in
 * the `handler` group, Fastify's `done` in a hook group. `next(err)` skips the rest and fails. To answer
 * the request from the middleware itself, write with `ctx.body()` and do not call `next`.
 *
 * Calling it twice in one middleware is a bug, not a fallback, and throws.
 */
export type Next = (err?: Error) => void

/**
 * The functional form of a middleware. Call `next` to continue; omit it to short-circuit.
 *
 * `V` names what the middleware reads and writes through `ctx.state`, and `C` what `ctx.config` carries:
 *
 * ```ts
 * const tenancy: MiddlewareFn<{ tenant: Tenant }> = (ctx, next) => {
 *   ctx.state.set('tenant', resolve(ctx))
 *   next()
 * }
 * ```
 */
export type MiddlewareFn<V = Record<never, never>, C = Record<never, never>> = (ctx: Context<V, C>, next: Next) => void

/**
 * The class form of a middleware, which is what a middleware with dependencies should be: bind it in the
 * container and register it by class or key, and the container injects it.
 *
 * ```ts
 * class Tagger implements Middleware {
 *   handle(ctx: Context, next: Next) {
 *     ctx.header('x-tag', '1')
 *     next()
 *   }
 * }
 *
 * app.use(Tagger)
 * ```
 */
export interface Middleware<V = Record<never, never>, C = Record<never, never>> {
  handle(ctx: Context<V, C>, next: Next): void
}

/**
 * Where a middleware runs.
 *
 * `handler` (the default) runs immediately before the controller. Not calling `next()` skips the handler.
 * It covers routes the application's controllers declare — not the ones the framework registers for itself
 * (health probes, the OIDC callback, static files, views), which have no controller to wrap.
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
