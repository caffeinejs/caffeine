import { configureRoute, configureRouteGroup, type AnyRouteExtension } from '@caffeinejs/http'

import type { CorsOptions } from './cors_plugin.js'

/**
 * Sets per-route CORS options, or turns CORS off for the route with `false`.
 *
 * Needs `@fastify/cors` registered on the server (via `.extend(() => corsPlugin())`); this is the per-route half of it.
 * `@fastify/cors` reads `req.routeOptions.config.cors` and merges it with the global options.
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
