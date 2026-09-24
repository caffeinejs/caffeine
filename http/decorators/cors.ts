import type { AnyRouteExtension } from '../routing/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * The `@fastify/cors` options bag.
 *
 * Empty here — this package has no dependency on `@fastify/cors`, so `cors(...)`/`@CORS(...)` type-check
 * against any object with no cast. A consumer who has `@fastify/cors` installed and wants the real shape
 * checked augments it in their own code:
 *
 * ```ts
 * declare module '@caffeinejs/http' {
 *   interface CorsOptions extends import('@fastify/cors').FastifyCorsOptions {}
 * }
 * ```
 */
export interface CorsOptions {}

/**
 * Sets per-route CORS options, or turns CORS off for the route with `false`.
 *
 * Needs `@fastify/cors` registered on the server — this is the per-route half of it. `@fastify/cors` reads
 * `req.routeOptions.config.cors` and merges it with the global options.
 *
 * ```ts
 * .with(({ config }) => [fastifyCors, config.app.cors.options])
 * ```
 */
export function cors(options: CorsOptions | boolean): AnyRouteExtension {
  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config('cors', options)
  }
}

/**
 * Sets CORS options on a controller or a single route, or turns CORS off with `false`.
 *
 * The programmatic form is {@link cors}.
 */
export function CORS(options: CorsOptions | boolean) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, cors(options))
    } else {
      configureRoute(context, cors(options))
    }
  }
}
