import { RouteContributor, type AdapterRouteOptions, type RouteContributorContext } from '@caffeinejs/http'
import { kExtensionStage, type ExtensionStage } from '@caffeinejs/std'

import './_fastify.js'
import { attachCacheHooks, resolveCacheDeps, type CacheDeps, type CacheOptions } from './cache.js'
import { attachCacheInvalidateHook, type CacheInvalidateOptions } from './cache_invalidate.js'

/**
 * Attaches the cache read/store and eviction hooks to the routes that declared `@Cache` / `@CacheInvalidate`.
 *
 * `gate` stage, so it registers behind request-gating features — install `caching` after `authentication`.
 */
export class CacheRouteContributor extends RouteContributor {
  readonly name = 'caffeine-caching'
  readonly [kExtensionStage]: ExtensionStage = 'gate'

  #deps: CacheDeps | undefined

  override configure(ctx: RouteContributorContext): void {
    // Resolved once, never per route and never per request.
    this.#deps = resolveCacheDeps(ctx.container)
    ctx.server.decorateRequest('responseCached', false)
  }

  onRoute(routeDef: AdapterRouteOptions): void {
    const config = routeDef.config as Record<string, unknown> | undefined

    const cacheOpts = config?.cache as CacheOptions | false | undefined
    if (cacheOpts !== undefined) {
      attachCacheHooks(routeDef, cacheOpts, this.#deps!)
    }

    const invalidateOpts = config?.cacheInvalidate as CacheInvalidateOptions | false | undefined
    if (invalidateOpts !== undefined && invalidateOpts !== false) {
      attachCacheInvalidateHook(routeDef, invalidateOpts, this.#deps!.store)
    }
  }
}
