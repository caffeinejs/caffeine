import { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { addRouteHook } from '../internal/route_hooks.js'
import { CacheStore } from './store.js'

export interface CacheInvalidateOptions {
  paths?: string[]
  segment?: string
}

/**
 * Attaches the eviction hook to one route, per its `@CacheInvalidate` options.
 *
 * Evicts cached entries after a successful mutating request, targeting the {@link CacheStore} the cache
 * hooks write to. Like those, `opts` is closed over rather than re-read per request.
 */
export function attachCacheInvalidateHook(
  routeDef: RouteOptions,
  opts: CacheInvalidateOptions,
  store: CacheStore,
): void {
  async function invalidateHandler(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
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

  addRouteHook(routeDef, 'onSend', invalidateHandler)
}
