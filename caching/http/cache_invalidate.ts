import {
  ErrConfiguration,
  addRouteHook,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
  type FastifyContextRequest,
} from '@caffeinejs/http'
import type { FastifyRequest } from 'fastify'

import { cacheRouteOf } from './_observe.js'
import { pathCacheKey, routeMethods } from './_util.js'
import type { CacheDeps } from './cache.js'
import { withStoreTimeout } from './store_timeout.js'

/**
 * What a route evicts once a mutating request is answered with a `2xx` or a `3xx` — one of three forms, never
 * mixed.
 *
 * - `paths`: literal paths, not patterns, each evicted as the GET representation the cache stored for it. The
 *   request's own URL when omitted. A path cannot reach a route that varies: the cache keeps one entry per
 *   combination of `Vary` values, and a path names none of them.
 * - `key`: the store keys to evict, used as returned. An entry is reached only under the exact key it was stored
 *   with: for a route whose `@CacheControl` has a `key` function, call that same function; for one on the default
 *   key, `cacheKey(req, { method: 'GET', url })` derives it from the evicting request. `req` is the request of the
 *   handler's own context, so it needs a server the application's adapter drives.
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
 * Evicts cached entries after a mutating request answered with a `2xx` or a `3xx`, targeting the store the
 * cache hooks write to. A store that rejects the eviction does not fail the response.
 *
 * @throws ErrConfiguration When `opts` mixes forms, or asks to `clear` without a `segment`.
 */
export function attachCacheInvalidateHook(
  routeDef: AdapterRouteOptions,
  opts: CacheInvalidateOptions,
  deps: CacheDeps,
): void {
  assertOneForm(routeDef, opts)

  const { store, observer, storeTimeoutMs } = deps
  const route = observer === undefined ? undefined : cacheRouteOf(routeDef)

  // RFC 9111 §4.4 — a non-error response, 2xx or 3xx, invalidates: a 303 after a form post evicts like a 200.
  // Events fire once the store settles: an eviction that rejected did not happen, and it costs the cache, never
  // the response to a mutation that already went through.
  async function invalidateHandler(request: AdapterRequest, reply: AdapterReply): Promise<unknown> {
    if (reply.statusCode < 200 || reply.statusCode >= 400) {
      return
    }

    if (opts.clear === true) {
      try {
        await withStoreTimeout(store.clear(opts.segment), 'clear', storeTimeoutMs)
        observer?.onInvalidate?.({ route: route!, segment: opts.segment, scope: 'segment' })
      } catch (error) {
        observer?.onError?.({ route: route!, segment: opts.segment, operation: 'clear', error })
      }

      return
    }

    const keys = keysOf(request, opts)
    try {
      await withStoreTimeout(store.deleteMany(keys, opts.segment), 'delete', storeTimeoutMs)
      observer?.onInvalidate?.({ route: route!, segment: opts.segment, scope: 'keys', keys })
    } catch (error) {
      observer?.onError?.({ route: route!, segment: opts.segment, operation: 'delete', error })
    }

    return
  }

  addRouteHook(routeDef, 'onSend', invalidateHandler)
}

function keysOf(request: AdapterRequest, opts: CacheInvalidateOptions): string[] {
  if (opts.key !== undefined) {
    const keys = opts.key((request as FastifyRequest).httpContext.req)
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
