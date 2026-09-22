import { DeferredCtor, type Container, type InjectionToken } from '@caffeinejs/di'
import {
  ErrConfiguration,
  type AdapterRouteOptions,
  type HTTPPluginConfigurer,
  type HTTPPluginFactory,
  type HTTPSetupContext,
} from '@caffeinejs/http'
import type { Duration } from '@caffeinejs/std'
import { bytes, type ByteSize } from '@caffeinejs/std/bytes'
import type { Logger } from '@caffeinejs/std/logger'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import './_fastify.js'
import { guardObserver, storeErrorLogger } from './_observe.js'
import { strictSeconds } from './_util.js'
import { attachCacheHooks, type CacheDeps, type CacheControlOptions, type ETagGenerator } from './cache.js'
import { attachCacheInvalidateHook, type CacheInvalidateOptions } from './cache_invalidate.js'
import type { FlightTable } from './flight.js'
import { composeObservers, type CacheObserver } from './observer.js'
import { DEFAULT_STATUS_HEADER, type HTTPCachingOptions } from './options.js'
import { kBuild, HTTPCachingOptionsBuilder } from './options_builder.js'
import type { HTTPCacheStore } from './store.js'

/** Authors {@link HTTPCachingOptions} through {@link HTTPCachingOptionsBuilder} instead of the plain object. */
export type HTTPCachingConfigurer<C = unknown> = HTTPPluginConfigurer<HTTPCachingOptionsBuilder, C>

/**
 * HTTP response caching, as an ordinary Fastify plugin factory: `.with(HTTPCaching())`.
 *
 * Takes an options object or a builder callback. Neither binds anything into the container — `store`,
 * `etagGenerator` and `observer` are resolved once as the plugin registers, from the option given. An omitted
 * `etagGenerator` is an internal SHA-1 hash. `store` has no default: installing without one throws
 * {@link ErrConfiguration}, and so does any of the three given as a token that resolves to nothing.
 *
 * An `observer` that throws is caught; its first throw from each method is logged on the application logger. A
 * store that rejects never fails a request: the cache goes on without it, tells `observer.onError`, and logs the
 * failure itself when the observer does not listen for it. A store that never answers is bounded only by
 * `storeTimeout`, which has no default.
 *
 * Concurrent misses for one key run the handler once: the first request leads, the others wait, up to
 * `lockTimeout`, for what it stores. The wait is in this process alone.
 *
 * Being a plain plugin factory rather than a feature, it installs once per context — the root, or one route
 * group with `router.plugin(...)` / `@Use(...)` — each with its own settings.
 *
 * Per-route behavior is the `@CacheControl` / `@CacheInvalidate` decorators or the `cacheControl()` /
 * `cacheInvalidate()` route extensions. Install it after `.authentication(...)`, and before a plugin that
 * compresses responses: a payload a compressor already turned into a stream is neither hashed nor stored.
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
      observer: guardObserver(withStoreErrorLogger(observer, logger), logger),
      storeTimeoutMs: resolveTimeout('storeTimeout', resolved.storeTimeout, undefined),
      // One table per install: a root install and a group install have stores of their own, and flights too.
      flights: new Map() as FlightTable,
      lockTimeoutMs: resolveTimeout('lockTimeout', resolved.lockTimeout, DEFAULT_LOCK_TIMEOUT_MS),
      varyByQuery: resolved.varyByQuery === undefined ? undefined : Object.freeze([...resolved.varyByQuery]),
      maxEntrySizeBytes: resolveMaxEntrySize(resolved.maxEntrySize),
    })
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000

function resolveTimeout<D extends number | undefined>(
  option: 'storeTimeout' | 'lockTimeout',
  value: Duration | undefined,
  fallback: D,
): number | D {
  if (value === undefined) {
    return fallback
  }

  const seconds = strictSeconds(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ErrConfiguration(
      `Cannot install HTTP caching: ${option} must be a positive duration such as 1 or "250ms", got "${String(value)}"`,
    )
  }

  return Math.ceil(seconds * 1000)
}

function resolveMaxEntrySize(value: ByteSize | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  try {
    return bytes(value)
  } catch {
    throw new ErrConfiguration(
      `Cannot install HTTP caching: maxEntrySize must be a byte size such as 1048576 or "1MB", got "${String(value)}"`,
    )
  }
}

// A store failure is never silent: an observer that listens for it owns the report, otherwise it is logged.
function withStoreErrorLogger(observer: CacheObserver | undefined, logger: Logger): CacheObserver {
  if (observer === undefined) {
    return storeErrorLogger(logger)
  }

  return observer.onError === undefined ? composeObservers(observer, storeErrorLogger(logger)) : observer
}

function build<C>(configure: HTTPCachingConfigurer<C>, context: HTTPSetupContext<C>): HTTPCachingOptions {
  const builder = new HTTPCachingOptionsBuilder()
  configure(builder, context)
  return builder[kBuild]()
}

// A real store instance is always an object; an InjectionToken is a class, a DeferredCtor, or a branded
// string/symbol — never a plain object — so the two are told apart by shape. `store` has no default: an omitted
// store, or a token that resolves to nothing, both throw.
function resolveCache(
  value: HTTPCacheStore | InjectionToken<HTTPCacheStore> | undefined,
  container: Container,
): HTTPCacheStore {
  if (value === undefined) {
    throw new ErrConfiguration(
      'Cannot install HTTP caching without a store: pass one explicitly, e.g. .store(new MemoryHTTPCacheStore())',
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

// Told apart from a token by shape, like `store`: an observer is a plain object or a class instance. A token
// that resolves to nothing throws: silently running without the observer someone asked for would only show up as
// an empty dashboard.
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
    const resolved = container.getOptional(value)
    if (resolved === undefined) {
      throw new ErrConfiguration('Cannot install HTTP caching: no binding registered for the given etagGenerator token')
    }
    return resolved
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
 * A `key` function is handed the request of the handler's own context, which exists only on a server the
 * application's adapter drives. Everything else works on any server.
 *
 * Installs once per context — the root, or one route group — and a second registration on the same context is
 * refused.
 */
export function cachePlugin(deps: CacheDeps): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    if (!instance.hasRequestDecorator('responseCached')) {
      instance.decorateRequest('responseCached', false)
    }

    if (!instance.hasRequestDecorator('cacheKey')) {
      instance.decorateRequest('cacheKey', null)
    }

    if (!instance.hasRequestDecorator('cacheFlight')) {
      instance.decorateRequest('cacheFlight', null)
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
