import type { Logger } from '@caffeinejs/application/logger'
import { isValidKey, type Container, type InjectionToken } from '@caffeinejs/di'
import {
  ErrConfiguration,
  HTTPPlugin,
  type HTTPPluginFactory,
  type HTTPPluginConfigurer,
  type HTTPSetupContext,
} from '@caffeinejs/http'
import { type ByteSize, formatBytes } from '@caffeinejs/std/bytes'
import { type Duration, formatDuration, Second } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { guardObserver, storeErrorLogger } from './_observe.js'
import { attachCacheHooks, type CacheDeps, type ETagGenerator } from './cache_control.js'
import { attachCacheInvalidateHook } from './cache_invalidate.js'
import type { FlightTable } from './flight.js'
import { composeObservers, type CacheObserver } from './observer.js'
import { DEFAULT_STATUS_HEADER, type HTTPCachingOptions } from './options.js'
import { kBuild, HTTPCachingOptionsBuilder } from './options_builder.js'
import type { HTTPCacheStore } from './store.js'

/** Authors {@link HTTPCachingOptions} through {@link HTTPCachingOptionsBuilder} instead of the plain object. */
export type HTTPCachingConfigurer<C = unknown> = HTTPPluginConfigurer<HTTPCachingOptionsBuilder, C>

/**
 * HTTP response caching, as a plugin factory: `.with(HTTPCaching())`.
 *
 * Takes an options object or a builder callback. Neither binds anything into the container — `store`,
 * `etagGenerator` and `observer` are resolved once as the plugin registers, from the option given. An omitted
 * `etagGenerator` is an internal SHA-1 hash. `store` has no default: installing without one throws
 * {@link ErrConfiguration}, and so does any of the three given as a token that resolves to nothing.
 *
 * An `observer` that throws is caught; its first throw from each method is logged on the application logger. A
 * store that rejects never fails a request: the cache goes on without it, tells `observer.onError`, and logs the
 * failure itself when the observer does not listen for it. A store that never answers is given up on after
 * `storeTimeout`, two seconds unless set.
 *
 * Concurrent misses for one key run the handler once: the first request leads, the others wait, up to
 * `lockTimeout`, for what it stores. The wait is in this process alone.
 *
 * Being a plain plugin factory rather than a feature, it installs once per context — the root, or one route
 * group with `router.with(...)` / `@Use(...)` — each with its own settings.
 * Installed on a server and again on a router or a controller under it, it is refused at start-up.
 *
 * Per-route behavior is the `@CacheControl` / `@CacheInvalidate` decorators or the `cacheControl()` /
 * `cacheInvalidate()` route options, set with `.options(...)`. Wherever it is installed, its hooks run after every
 * hook of the server, its routers and the route's guards, so a request the authentication gate or a guard refuses is
 * never served from the store. A payload an earlier `onSend` hook turned into a stream is neither hashed nor stored.
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
      storeTimeout: resolveTimeout('storeTimeout', resolved.storeTimeout, DEFAULT_STORE_TIMEOUT),
      // One table per install: a root install and a group install have stores of their own, and flights too.
      flights: new Map() as FlightTable,
      lockTimeout: resolveTimeout('lockTimeout', resolved.lockTimeout, DEFAULT_LOCK_TIMEOUT),
      varyByQuery: resolved.varyByQuery === undefined ? undefined : Object.freeze([...resolved.varyByQuery]),
      maxEntrySize: resolveMaxEntrySize(resolved.maxEntrySize),
    })
  }
}

const DEFAULT_STORE_TIMEOUT = 2 * Second
const DEFAULT_LOCK_TIMEOUT = 10 * Second

function resolveTimeout(
  option: 'storeTimeout' | 'lockTimeout',
  value: Duration | undefined,
  fallback: Duration,
): Duration {
  if (value === undefined) {
    return fallback
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new ErrConfiguration(
      errMessage(
        `Cannot install HTTP caching: ${option} must be a positive duration such as 250 * Millisecond, got "${formatDuration(value)}"`,
      )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return value
}

function resolveMaxEntrySize(value: ByteSize | undefined): ByteSize | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ErrConfiguration(
      errMessage(
        `Cannot install HTTP caching: maxEntrySize must be a whole number of bytes such as 1 * MiB, got "${formatBytes(value)}"`,
      )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return value
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
      errMessage(
        'Cannot install HTTP caching without a store: pass one explicitly, e.g. .store(new MemoryHTTPCacheStore())',
      )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  if (isValidKey(value)) {
    const resolved = container.getOptional(value)
    if (resolved === undefined) {
      throw new ErrConfiguration(
        errMessage('Cannot install HTTP caching: no binding registered for the given store token')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
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

  if (isValidKey(value)) {
    const resolved = container.getOptional(value)
    if (resolved === undefined) {
      throw new ErrConfiguration(
        errMessage('Cannot install HTTP caching: no binding registered for the given observer token')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
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
      throw new ErrConfiguration(
        errMessage('Cannot install HTTP caching: no binding registered for the given etagGenerator token')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
    return resolved
  }

  // Not a token by elimination — the class-token shapes InjectionToken<T> also allows do not apply to a
  // function-valued T, so what remains is the generator itself.
  return value as ETagGenerator
}

class CachingPlugin extends HTTPPlugin {
  // What refuses two installs in one slot, and how the server finds them.
  override readonly name = '@caffeinejs/caching'
  readonly #deps: CacheDeps

  constructor(deps: CacheDeps) {
    super()
    this.#deps = deps
  }

  register(context: HTTPSetupContext): void {
    const deps = this.#deps

    context.app.hook('onRoute', route => {
      const cacheOpts = route.options.cache
      if (cacheOpts !== undefined) {
        attachCacheHooks(route, cacheOpts, deps)
      }

      const invalidateOpts = route.options.cacheInvalidate
      if (invalidateOpts !== undefined && invalidateOpts !== false) {
        attachCacheInvalidateHook(route, invalidateOpts, deps)
      }
    })
  }
}

/**
 * Attaches the cache read/store and eviction hooks to the routes that declared `@CacheControl` /
 * `@CacheInvalidate`.
 *
 * Per-route work happens in the server's `onRoute` hook. A route that declared neither gets no hook of the cache and
 * pays nothing.
 *
 * The hooks land behind the ones the server already runs, `@UseGuards` included, so a guard runs on a cache hit as
 * well as on a miss.
 *
 * Installs once per slot, the server's or one router's or controller's; a second install over the same route is
 * refused.
 */
export function cachePlugin(deps: CacheDeps): HTTPPlugin {
  return new CachingPlugin(deps)
}
