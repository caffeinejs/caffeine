import type { Container, InjectionToken } from '@caffeinejs/di'
import type { AdapterRouteOptions, HTTPPluginFactory } from '@caffeinejs/http'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import './_fastify.js'
import { attachCacheHooks, type CacheDeps, type CacheOptions, type ETagGenerator } from './cache.js'
import { attachCacheInvalidateHook, type CacheInvalidateOptions } from './cache_invalidate.js'
import { DEFAULT_STATUS_HEADER, type HTTPCachingOptions } from './options.js'
import { kBuild, HTTPCachingOptionsBuilder } from './options_builder.js'
import { CacheStore, MemoryCacheStore } from './store.js'

/** Authors {@link HTTPCachingOptions} through {@link HTTPCachingOptionsBuilder} instead of the plain object. */
export type HTTPCachingConfigurer = (builder: HTTPCachingOptionsBuilder) => void

/**
 * HTTP response caching, as an ordinary Fastify plugin factory: `.with(HTTPCaching())`.
 *
 * Takes an options object or a builder callback. Neither binds anything into the container — `store` and
 * `etagGenerator` are resolved once as the plugin registers, from the option given or, failing that, an
 * internal default ({@link MemoryCacheStore}, a SHA-1 hash). Being a plain plugin factory rather than a
 * feature, it installs once per context — the root, or one route group with `router.plugin(...)` / `@Use(...)`
 * — each with its own settings.
 *
 * Per-route behavior is the `@Cache` / `@CacheInvalidate` decorators or the `cache()` / `cacheInvalidate()`
 * route extensions. Install it after `.authentication(...)`.
 */
export function HTTPCaching<C = unknown>(options?: HTTPCachingOptions | HTTPCachingConfigurer): HTTPPluginFactory<C> {
  return (_config, container) => {
    const resolved = typeof options === 'function' ? build(options) : (options ?? {})

    return cachePlugin({
      store: resolveStore(resolved.store, container),
      etagGenerator: resolveETagGenerator(resolved.etagGenerator, container),
      statusHeader: resolved.statusHeader ?? DEFAULT_STATUS_HEADER,
    })
  }
}

function build(configure: HTTPCachingConfigurer): HTTPCachingOptions {
  const builder = new HTTPCachingOptionsBuilder()
  configure(builder)
  return builder[kBuild]()
}

// A real instance is told apart from a token by `instanceof`; anything else is read from the container.
function resolveStore(value: CacheStore | InjectionToken<CacheStore> | undefined, container: Container): CacheStore {
  if (value instanceof CacheStore) {
    return value
  }

  const resolved = value !== undefined ? container.getOptional(value) : undefined
  return resolved ?? new MemoryCacheStore()
}

// `ETagGenerator` is a function type, so a token is told apart by shape instead: a `string`/`symbol` names a
// binding, a `function` is the generator itself. A class-shaped token for a function type is not realistic in
// this DI (a constructor whose instances are callable) and is not supported.
function resolveETagGenerator(
  value: ETagGenerator | InjectionToken<ETagGenerator> | undefined,
  container: Container,
): ETagGenerator | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'string' || typeof value === 'symbol') {
    return container.getOptional(value)
  }

  // Not a token by elimination — the class-token shapes InjectionToken<T> also allows do not apply to a
  // function-valued T, so what remains is the generator itself.
  return value as ETagGenerator
}

/**
 * Attaches the cache read/store and eviction hooks to the routes that declared `@Cache` / `@CacheInvalidate`.
 *
 * Per-route work happens in Fastify's own `onRoute` hook, which fires while each route registers and may
 * still rewrite its options. A route that declared neither keeps its hook slots undefined and pays nothing.
 *
 * The hooks land behind the ones the adapter already attached, `@UseGuards` included, so a guard runs on a
 * cache hit as well as on a miss.
 *
 * `deps` is resolved by the caller (`HTTPCaching`) — this plugin never touches the container. Named and
 * `fastify-plugin`-wrapped like any other first-party plugin, so it installs once per context — root, or one
 * route group with `router.plugin(...)` / `@Use(...)` — not stacked repeatedly onto the identical context.
 */
export function cachePlugin(deps: CacheDeps): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    if (!instance.hasRequestDecorator('responseCached')) {
      instance.decorateRequest('responseCached', false)
    }

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

  return fp(plugin, { name: '@caffeinejs/caching' })
}
