import { FastifyCompressOptions } from '@fastify/compress'
import type { AnyRouteExtension } from '../routing/programmatic/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Compresses the response, or turns compression off for the route with `false`.
 *
 * Needs `@fastify/compress` registered on the server; this is the per-route half of it.
 */
export function compress(options: FastifyCompressOptions | false): AnyRouteExtension {
  return (target: { options(key: string, value: unknown): unknown }) => {
    target.options('compress', options)
  }
}

export function Compress(options: FastifyCompressOptions | false) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, compress(options))
    } else {
      configureRoute(context, compress(options))
    }
  }
}
