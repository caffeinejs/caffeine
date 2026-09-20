import { DeferredCtor, type Container, type InjectionToken } from '@caffeinejs/di'
import {
  ErrConfiguration,
  type AdapterRouteOptions,
  type HTTPPluginConfigurer,
  type HTTPPluginFactory,
  type HTTPSetupContext,
} from '@caffeinejs/http'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import './_fastify.js'
import type { Cache } from '../store.js'
import { guardObserver } from './_observe.js'
import { attachCacheHooks, type CacheDeps, type CacheControlOptions, type ETagGenerator } from './cache.js'
import { attachCacheInvalidateHook, type CacheInvalidateOptions } from './cache_invalidate.js'
import type { CacheObserver } from './observer.js'
import { DEFAULT_STATUS_HEADER, type HTTPCachingOptions } from './options.js'
import { kBuild, HTTPCachingOptionsBuilder } from './options_builder.js'

/** Authors {@link HTTPCachingOptions} through {@link HTTPCachingOptionsBuilder} instead of the plain object. */
export type HTTPCachingConfigurer<C = unknown> = HTTPPluginConfigurer<HTTPCachingOptionsBuilder, C>

/**
 * HTTP response caching, as an ordinary Fastify plugin factory: `.with(HTTPCaching())`.
 *
 * Takes an options object or a builder callback. Neither binds anything into the container — `store`,
 * `etagGenerator` and `observer` are resolved once as the plugin registers, from the option given or, for
 * `etagGenerator` alone, an internal default (a SHA-1 hash). `store` has no default: installing without one throws
 * {@link ErrConfiguration}. An `observer` that throws is caught; its first throw from each method is logged on the
 * application logger. Being a plain plugin factory rather than a feature, it installs once per
 * context — the root, or one route group with `router.plugin(...)` / `@Use(...)` — each with its own
 * settings.
 *
 * Per-route behavior is the `@CacheControl` / `@CacheInvalidate` decorators or the `cacheControl()` /
 * `cacheInvalidate()` route extensions. Install it after `.authentication(...)`.
 */
export function HTTPCaching<C = unknown>(
  options?: HTTPCachingOptions | HTTPCachingConfigurer<C>,
): HTTPPluginFactory<C> {
  return context => {
    const { container, logger } = context
    const resolved = typeof options === 'function' ? build(options, context) : (options ?? {})

    const store = resolveCache(resolved.store, container)
    const observer = resolveObserver(resolved.observer, container)

    return cachePlugin({
      store,
      etagGenerator: resolveETagGenerator(resolved.etagGenerator, container),
      statusHeader: resolved.statusHeader ?? DEFAULT_STATUS_HEADER,
      observer: observer === undefined ? undefined : guardObserver(observer, logger),
    })
  }
}

function build<C>(configure: HTTPCachingConfigurer<C>, context: HTTPSetupContext<C>): HTTPCachingOptions {
  const builder = new HTTPCachingOptionsBuilder()
  configure(builder, context)
  return builder[kBuild]()
}

// A real Cache instance is always an object; an InjectionToken is a class, a DeferredCtor, or a branded
// string/symbol — never a plain object — so the two are told apart by shape. Unlike `etagGenerator`, `store`
// has no default: an omitted store, or a token that resolves to nothing, both throw.
function resolveCache(value: Cache | InjectionToken<Cache> | undefined, container: Container): Cache {
  if (value === undefined) {
    throw new ErrConfiguration(
      'Cannot install HTTP caching without a store: pass one explicitly, e.g. .store(new MemoryCache())',
    )
  }

  if (
    typeof value === 'string' ||
    typeof value === 'symbol' ||
    typeof value === 'function' ||
    value instanceof DeferredCtor
  ) {
    const resolved = container.getOptional(value)
    if (resolved === undefined) {
      throw new ErrConfiguration('Cannot install HTTP caching: no binding registered for the given store token')
    }
    return resolved
  }

  return value
}

// Told apart from a token by shape, like `store`: an observer is a plain object or a class instance. Unlike
// `etagGenerator`, a token that resolves to nothing throws — there is no default to fall back to, and silently
// running without the observer someone asked for would only show up as an empty dashboard.
function resolveObserver(
  value: CacheObserver | InjectionToken<CacheObserver> | undefined,
  container: Container,
): CacheObserver | undefined {
  if (value === undefined) {
    return undefined
  }

  if (
    typeof value === 'string' ||
    typeof value === 'symbol' ||
    typeof value === 'function' ||
    value instanceof DeferredCtor
  ) {
    const resolved = container.getOptional(value)
    if (resolved === undefined) {
      throw new ErrConfiguration('Cannot install HTTP caching: no binding registered for the given observer token')
    }
    return resolved
  }

  return value
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
 * Attaches the cache read/store and eviction hooks to the routes that declared `@CacheControl` /
 * `@CacheInvalidate`.
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

      const cacheOpts = config?.cache as CacheControlOptions | false | undefined
      if (cacheOpts !== undefined) {
        attachCacheHooks(routeDef, cacheOpts, deps)
      }

      const invalidateOpts = config?.cacheInvalidate as CacheInvalidateOptions | false | undefined
      if (invalidateOpts !== undefined && invalidateOpts !== false) {
        attachCacheInvalidateHook(routeDef, invalidateOpts, deps)
      }
    })
  }

  return fp(plugin, { name: '@caffeinejs/caching' })
}
