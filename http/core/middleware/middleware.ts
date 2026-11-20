import type { Ctor, InjectionToken } from '@caffeinejs/di'

import type { IContext } from '../../context.js'
import type { HTTPSetupContext } from '../../plugin.js'
import type { RequestHookName } from '../lifecycle/lifecycle.js'

/**
 * Optional preferred hook for a middleware, when `use()` does not pass `{ hook }`: a request hook point
 * (`RequestHookName`).
 *
 * Omit it and the middleware runs at `onRequest`. On a class, declare it as a static getter. On a function, set it as a
 * property. A name that is not a request hook point is refused at start-up.
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
 * Builds a middleware once at start-up, from the same context a plugin factory gets: the configuration, the
 * container and the logger.
 *
 * `config` is the live handle, so `config.someSetting` reads the current tree. A later refresh does not rebuild
 * the middleware.
 */
export type MiddlewareFactory<C = unknown> = (context: HTTPSetupContext<C>) => MiddlewareFn | Middleware

export type MiddlewarePath = string | readonly string[]

/** Where `use()` runs a middleware: a request hook point, `onRequest` when left out. */
export interface MiddlewareOptions {
  hook?: RequestHookName
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
export type MiddlewareFn<V = Record<never, never>, C = Record<never, never>> = (ctx: IContext<V, C>, next: Next) => void

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
 *   handle(ctx: IContext, next: Next) {
 *     ctx.header('x-tag', '1')
 *     next()
 *   }
 * }
 *
 * app.use(Tagger)
 * ```
 *
 * The static getter is optional; without it the class runs at `onRequest`.
 * `{ hook }` on `use()` overrides {@link kMiddlewareHook}.
 */
export interface Middleware<V = Record<never, never>, C = Record<never, never>> {
  handle(ctx: IContext<V, C>, next: Next): void
}

/** Anything `use()` accepts as its middleware argument. */
export type MiddlewareTarget<C = unknown> =
  | MiddlewareFn
  | Middleware
  | InjectionToken<Middleware>
  | MiddlewareFactory<C>

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

/**
 * Reads what a `use(...)` or `useFn(...)` call was given: a path or none, then the middleware, then `{ hook }`.
 *
 * @param argCount - How many arguments the call was given: a string no middleware follows is a container key, not
 *   a path.
 */
export function parseUse<C>(
  pathOrTarget: MiddlewarePath | MiddlewareTarget<C>,
  targetOrOptions: MiddlewareTarget<C> | MiddlewareOptions | undefined,
  options: MiddlewareOptions | undefined,
  argCount: number,
): { path: MiddlewarePath | undefined; target: unknown; hook?: RequestHookName } {
  const asPath =
    Array.isArray(pathOrTarget) ||
    (typeof pathOrTarget === 'string' && argCount >= 2 && !isMiddlewareOptions(targetOrOptions))

  if (asPath) {
    return {
      path: pathOrTarget as MiddlewarePath,
      target: targetOrOptions,
      hook: options?.hook,
    }
  }

  return {
    path: undefined,
    target: pathOrTarget,
    hook: isMiddlewareOptions(targetOrOptions) ? targetOrOptions.hook : undefined,
  }
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
