import {
  ErrConfiguration,
  FastifyContextRequest,
  addRouteHook,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
} from '@caffeinejs/http'
import type { FastifyRequest } from 'fastify'

import { cacheRouteOf } from './_observe.js'
import { pathCacheKey, routeMethods } from './_util.js'
import type { CacheDeps } from './cache.js'

/**
 * What a route evicts once a mutating request succeeds — one of three forms, never mixed.
 *
 * - `paths`: literal paths, not patterns, each evicted as the GET representation the cache stored for it. The
 *   request's own URL when omitted. A path cannot reach a route that varies: the cache keeps one entry per
 *   combination of `Vary` values, and a path names none of them.
 * - `key`: the store keys to evict, for a route whose `@CacheControl` derives its key with `key` too. Used as
 *   returned, the way the cache stored them.
 * - `clear`: every entry in `segment` — the one form that reaches a varying route's entries. `segment` is
 *   required, since clearing without one would empty the whole store.
 *
 * `segment` must match the `segment` of the `@CacheControl` that stored the entries.
 */
export type CacheInvalidateOptions =
  | { paths?: string[]; segment?: string; key?: never; clear?: never }
  | { key: (req: FastifyContextRequest) => string | string[]; segment?: string; paths?: never; clear?: never }
  | { clear: true; segment: string; paths?: never; key?: never }

/**
 * Attaches the eviction hook to one route, per its `@CacheInvalidate` options.
 *
 * Evicts cached entries after a successful mutating request, targeting the store the cache hooks write
 * to. Like those, `opts` is closed over rather than re-read per request.
 *
 * @throws ErrConfiguration When `opts` mixes forms, or asks to `clear` without a `segment`.
 */
export function attachCacheInvalidateHook(
  routeDef: AdapterRouteOptions,
  opts: CacheInvalidateOptions,
  deps: CacheDeps,
): void {
  assertOneForm(routeDef, opts)

  const { store, observer } = deps
  const route = observer === undefined ? undefined : cacheRouteOf(routeDef)

  // Events fire once the store settles: an eviction that rejected did not happen.
  async function invalidateHandler(request: AdapterRequest, reply: AdapterReply): Promise<unknown> {
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      return
    }

    if (opts.clear === true) {
      await store.clear(opts.segment)
      observer?.onInvalidate?.({ route: route!, segment: opts.segment, scope: 'segment' })
      return
    }

    const keys = keysOf(request, opts)
    await store.deleteMany(keys, opts.segment)
    observer?.onInvalidate?.({ route: route!, segment: opts.segment, scope: 'keys', keys })

    return
  }

  addRouteHook(routeDef, 'onSend', invalidateHandler)
}

function keysOf(request: AdapterRequest, opts: CacheInvalidateOptions): string[] {
  if (opts.key !== undefined) {
    const keys = opts.key(new FastifyContextRequest(request as FastifyRequest))
    return typeof keys === 'string' ? [keys] : keys
  }

  const paths = opts.paths ?? [request.url]

  const keys = new Array<string>(paths.length)
  for (let i = 0; i < paths.length; i++) {
    keys[i] = pathCacheKey(paths[i])
  }

  return keys
}

// Route config reaches here untyped from a route registered straight on Fastify, so the union's exclusivity is
// checked again at runtime.
function assertOneForm(routeDef: AdapterRouteOptions, opts: CacheInvalidateOptions): void {
  const forms = Number(opts.paths !== undefined) + Number(opts.key !== undefined) + Number(opts.clear === true)

  if (forms > 1) {
    throw new ErrConfiguration(
      `Cannot install cache invalidation on "${routeMethods(routeDef)} ${routeDef.url}": paths, key and clear are mutually exclusive`,
    )
  }

  if (opts.clear === true && !opts.segment) {
    throw new ErrConfiguration(
      `Cannot install cache invalidation on "${routeMethods(routeDef)} ${routeDef.url}": clear requires a segment`,
    )
  }
}
