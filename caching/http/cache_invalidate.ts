import { addRouteHook, type AdapterReply, type AdapterRequest, type AdapterRouteOptions } from '@caffeinejs/http'

import { cacheRouteOf } from './_observe.js'
import { assertTags } from './_util.js'
import type { CacheDeps } from './cache_control.js'
import { withStoreSignal } from './store_signal.js'

export interface CacheInvalidateOptions {
  /**
   * The tags to evict once the request is answered with a `2xx` or a `3xx`: every entry stored under any of
   * them, whatever route stored it. Non-empty strings without `{` or `}`; refused at start-up otherwise.
   */
  tags: string[]
}

/**
 * Attaches the eviction hook to one route, per its `@CacheInvalidate` options.
 *
 * Evicts by tag after a mutating request answered with a `2xx` or a `3xx`, on the store the cache hooks write
 * to. A store that rejects the eviction does not fail the response.
 *
 * @throws ErrConfiguration When `tags` is missing, empty, or holds a tag that is not a non-empty string without
 *   a brace.
 */
export function attachCacheInvalidateHook(
  routeDef: AdapterRouteOptions,
  opts: CacheInvalidateOptions,
  deps: CacheDeps,
): void {
  assertTags(routeDef, opts.tags, { what: 'cache invalidation', required: true })

  const { store, observer, storeTimeoutMs } = deps
  const route = observer === undefined ? undefined : cacheRouteOf(routeDef)
  const tags: readonly string[] = Object.freeze([...opts.tags])

  // RFC 9111 §4.4 — a non-error response, 2xx or 3xx, invalidates: a 303 after a form post evicts like a 200.
  // The event fires once the store settled: an eviction that rejected did not happen, and it costs the cache,
  // never the response to a mutation that already went through. The mutation is done, so the eviction is not
  // tied to the request's own signal. A response that evicts nothing is finished here and now, through `next`,
  // the way the cache hooks finish one (see `attachCacheHooks`).
  function invalidateHandler(
    _request: AdapterRequest,
    reply: AdapterReply,
    payload: unknown,
    next: (err: Error | null, payload?: unknown) => void,
  ): void | Promise<unknown> {
    if (reply.statusCode < 200 || reply.statusCode >= 400) {
      next(null, payload)
      return
    }

    return evict().then(() => payload)
  }

  async function evict(): Promise<void> {
    try {
      await withStoreSignal('evict', undefined, storeTimeoutMs, signal => store.evictByTag(tags, { signal }))
      observer?.onInvalidate?.({ route: route!, tags })
    } catch (error) {
      observer?.onError?.({ route: route!, operation: 'evict', error })
    }
  }

  addRouteHook(routeDef, 'onSend', invalidateHandler)
}
