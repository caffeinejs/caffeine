import { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { RouteConfigurer } from '../route_configurer.js'
import { CacheInvalidateOptions, CacheStore } from './types.js'

export function cacheInvalidateConfigurer(store: CacheStore): RouteConfigurer {
  return input => {
    const invalidateHandler = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<unknown> => {
      const config = request.routeOptions.config as unknown as Record<string, unknown> | undefined
      const opts = config?.cacheInvalidate as CacheInvalidateOptions | undefined
      if (!opts || reply.statusCode < 200 || reply.statusCode >= 300) {
        return
      }

      const segment = opts.segment ?? ''
      const paths = opts.paths ?? [request.url]

      const keys = new Array<string>(paths.length)
      for (let i = 0; i < paths.length; i++) {
        keys[i] = encodeURIComponent(paths[i])
      }

      await store.deleteMany(keys, segment)

      return
    }

    (input.routeDef.onSend as Array<RouteOptions['onSend']>).push(invalidateHandler)
  }
}
