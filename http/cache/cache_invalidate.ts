import { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { FeatureConfigurer, type RoutePhaseContext, type ServerPhaseContext } from '../feature_configurer.js'
import { CacheInvalidateOptions, CacheStore } from './types.js'

/**
 * Evicts cached entries after a successful mutating request, targeting the container-resolved
 * {@link CacheStore} (the same instance the `cache` configurer writes to). Runs after `cache`.
 */
export class CacheInvalidateConfigurer extends FeatureConfigurer {
  readonly name = 'cache-invalidate'
  readonly after = ['cache']
  #store!: CacheStore

  configureServer = (ctx: ServerPhaseContext): void => {
    this.#store = ctx.container.get(CacheStore)
  }

  configureRoute = (ctx: RoutePhaseContext): void => {
    const store = this.#store
    if (ctx.routeDef.config?.cacheInvalidate === undefined || ctx.routeDef.config?.cacheInvalidate === false) {
      return
    }

    async function invalidateHandler(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<unknown> {
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

    (ctx.routeDef.onSend as Array<RouteOptions['onSend']>).push(invalidateHandler)
  }
}
