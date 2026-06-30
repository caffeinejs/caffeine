import { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { RouteConfigurer } from '../route_configurer.js'
import { CacheInvalidateOptions, CacheStore } from './types.js'

export function cacheInvalidateConfigurer(store: CacheStore): RouteConfigurer {
  return input => {
    const invalidateHandler = async (
      request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
    ): Promise<unknown> => {
      const config = request.routeOptions.config as unknown as Record<string, unknown> | undefined
      const opts = config?.cacheInvalidate as CacheInvalidateOptions | undefined
      if (!opts || reply.statusCode < 200 || reply.statusCode >= 300) {
        return payload
      }

      const segment = opts.segment ?? ''
      const paths = opts.paths ?? [request.url]

      await store.deleteMany(paths.map(p => encodeURIComponent(p)), segment)

      return payload
    }

    (input.routeDef.onSend as Array<RouteOptions['onSend']>).push(invalidateHandler)
  }
}
