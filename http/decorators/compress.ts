import type { AnyRouteExtension } from '../routing/programmatic/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * The `@fastify/compress` options bag.
 *
 * Empty here — this package has no dependency on `@fastify/compress`, so `compress(...)`/`@Compress(...)`
 * type-check against any object with no cast. A consumer who has `@fastify/compress` installed and wants the
 * real shape checked augments it in their own code:
 *
 * ```ts
 * declare module '@caffeinejs/http' {
 *   interface CompressOptions extends import('@fastify/compress').FastifyCompressOptions {}
 * }
 * ```
 */
export interface CompressOptions {}

/**
 * Compresses the response, or turns compression off for the route with `false`.
 *
 * Needs `@fastify/compress` registered on the server — this is the per-route half of it.
 *
 * ```ts
 * .with(({ config }) =>
 *   fp(async instance => instance.register(fastifyCompress, config.app.compress.options), { name: 'compress' }),
 * )
 * ```
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
