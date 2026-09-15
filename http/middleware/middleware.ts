import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Ctor, InjectionToken } from '@caffeinejs/di'
import type { ConfigHandle } from '@caffeinejs/std/config'

import type { Context } from '../context.js'

/**
 * Optional preferred Fastify hook for a Caffeine middleware, when `use()` does not pass `{ hook }`.
 *
 * Omit it and the middleware runs at `onRequest`. On a class, declare it as a static getter. On a function,
 * set it as a property.
 */
export const kMiddlewareHook = Symbol('@caffeinejs/http:middlewareHook')

/**
 * Continues the rest of the pipeline, or fails it.
 *
 * `next()` runs the remaining middlewares of this hook. `next(err)` skips the rest and fails. To answer the
 * request from the middleware itself, write with `ctx.body()` and do not call `next`.
 *
 * Calling it twice in one middleware is a bug, not a fallback, and throws.
 */
export type Next = (err?: Error) => void

/**
 * A connect-style Node `(req, res, next)` middleware, run on the raw request and response.
 *
 * Registered under a path, it sees `req.url` with that path stripped, as connect mounts it.
 */
export type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void

/**
 * Builds a middleware once at start-up from the application's configuration.
 *
 * The function is called with the live config handle, so `c.someSetting` and `c(featureKey)` both work. A
 * later refresh does not rebuild the middleware.
 */
export type MiddlewareConfigFactory<C = unknown> = (
  config: ConfigHandle<C>,
) => NodeMiddleware | MiddlewareFn | Middleware

export type MiddlewarePath = string | readonly string[]

export interface MiddlewareOptions {
  hook?: MiddlewareHook
}

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
 *
 * To run at a later hook, set {@link kMiddlewareHook} on the function. `{ hook }` on `use()` overrides it.
 */
export type MiddlewareFn<V = Record<never, never>, C = Record<never, never>> = (ctx: Context<V, C>, next: Next) => void

/**
 * The class form of a middleware, which is what a middleware with dependencies should be: bind it in the
 * container and register it by class or key, and the container injects it.
 *
 * ```ts
 * class Tagger implements Middleware {
 *   static get [kMiddlewareHook](): MiddlewareHook {
 *     return 'preHandler'
 *   }
 *
 *   handle(ctx: Context, next: Next) {
 *     ctx.header('x-tag', '1')
 *     next()
 *   }
 * }
 *
 * app.use(Tagger)
 * ```
 *
 * The static getter is optional; without it the class runs at `onRequest`. `{ hook }` on `use()` overrides
 * {@link kMiddlewareHook}.
 */
export interface Middleware<V = Record<never, never>, C = Record<never, never>> {
  handle(ctx: Context<V, C>, next: Next): void
}

/**
 * Where a middleware runs: a Fastify request-lifecycle hook.
 *
 * Defaults to `onRequest`. Hooks cover every route, including ones the framework registers for itself, except
 * probe routes which have no context and are skipped. Use a later hook when the middleware must see a parsed
 * or validated body.
 */
export type MiddlewareHook =
  | 'onRequest'
  | 'preParsing'
  | 'preValidation'
  | 'preHandler'
  | 'preSerialization'
  | 'onSend'
  | 'onResponse'
  | 'onError'
  | 'onTimeout'

export const MIDDLEWARE_HOOKS: readonly MiddlewareHook[] = [
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'preSerialization',
  'onSend',
  'onResponse',
  'onError',
  'onTimeout',
]

/** Anything `use()` accepts as its middleware argument. */
export type MiddlewareTarget<C = unknown> =
  | NodeMiddleware
  | MiddlewareFn
  | Middleware
  | InjectionToken<Middleware>
  | MiddlewareConfigFactory<C>

export type MiddlewareResolvable = Middleware | InjectionToken<Middleware>

/** Whether `value` is a `{ hook }` options object rather than a middleware. */
export function isMiddlewareOptions(value: unknown): value is MiddlewareOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  if (isMiddlewareInstance(value)) {
    return false
  }
  const keys = Object.keys(value)
  return keys.every(key => key === 'hook')
}

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
