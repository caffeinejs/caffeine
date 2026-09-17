import { addRouteHook, type AdapterReply, type AdapterRequest, type AdapterRouteOptions } from '@caffeinejs/http'

import type { Cache } from '../store.js'

export interface CacheInvalidateOptions {
  paths?: string[]
  segment?: string
}

/**
 * Attaches the eviction hook to one route, per its `@CacheInvalidate` options.
 *
 * Evicts cached entries after a successful mutating request, targeting the {@link Cache} the cache
 * hooks write to. Like those, `opts` is closed over rather than re-read per request.
 */
export function attachCacheInvalidateHook(
  routeDef: AdapterRouteOptions,
  opts: CacheInvalidateOptions,
  store: Cache,
): void {
  async function invalidateHandler(request: AdapterRequest, reply: AdapterReply): Promise<unknown> {
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      return
    }

    const paths = opts.paths ?? [request.url]

    const keys = new Array<string>(paths.length)
    for (let i = 0; i < paths.length; i++) {
      keys[i] = encodeURIComponent(paths[i])
    }

    await store.deleteMany(keys, opts.segment)

    return
  }

  addRouteHook(routeDef, 'onSend', invalidateHandler)
}
