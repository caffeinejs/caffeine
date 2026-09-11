import type { AdapterRouteOptions, HTTPPlugin } from '@caffeinejs/http'
import fp from 'fastify-plugin'

import './_fastify.js'
import { attachCacheHooks, resolveCacheDeps, type CacheOptions } from './cache.js'
import { attachCacheInvalidateHook, type CacheInvalidateOptions } from './cache_invalidate.js'

/**
 * Attaches the cache read/store and eviction hooks to the routes that declared `@Cache` / `@CacheInvalidate`.
 *
 * Per-route work happens in Fastify's own `onRoute` hook, which fires while each route registers and may
 * still rewrite its options. A route that declared neither keeps its hook slots undefined and pays nothing.
 *
 * The hooks land behind the ones the adapter already attached, `@UseGuards` included, so a guard runs on a
 * cache hit as well as on a miss.
 */
export function cachePlugin(): HTTPPlugin {
  const plugin: HTTPPlugin = async (instance, { container }) => {
    // Resolved once, never per route and never per request.
    const deps = resolveCacheDeps(container)
    instance.decorateRequest('responseCached', false)

    instance.addHook('onRoute', routeOptions => {
      const routeDef = routeOptions as AdapterRouteOptions
      const config = routeDef.config as Record<string, unknown> | undefined

      const cacheOpts = config?.cache as CacheOptions | false | undefined
      if (cacheOpts !== undefined) {
        attachCacheHooks(routeDef, cacheOpts, deps)
      }

      const invalidateOpts = config?.cacheInvalidate as CacheInvalidateOptions | false | undefined
      if (invalidateOpts !== undefined && invalidateOpts !== false) {
        attachCacheInvalidateHook(routeDef, invalidateOpts, deps.store)
      }
    })
  }

  return fp(plugin, { name: 'caffeine-caching' })
}
