import { configureRoute, configureRouteGroup, type AnyRouteExtension } from '@caffeinejs/http'

import type { CompressOptions } from './compress_plugin.js'

/**
 * Compresses the response, or turns compression off for the route with `false`.
 *
 * Needs `@fastify/compress` registered on the server (via `.extend(() => compressPlugin())`); this is the per-route half of it.
 */
export function compress(options: CompressOptions | false): AnyRouteExtension {
  return (target: { options(key: string, value: unknown): unknown }) => {
    target.options('compress', options)
  }
}

/**
 * Compresses the response on a controller or a single route, or turns compression off with `false`.
 *
 * The programmatic form is {@link compress}.
 */
export function Compress(options: CompressOptions | false) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, compress(options))
    } else {
      configureRoute(context, compress(options))
    }
  }
}
