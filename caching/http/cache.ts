import {
  addRouteHook,
  appendVary,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
  type FastifyContextRequest,
  type Principal,
} from '@caffeinejs/http'
import type { Duration } from '@caffeinejs/std'
import type { FastifyRequest } from 'fastify'

import './_fastify.js'
import { cacheRouteOf } from './_observe.js'
import {
  applyStoredHeaders,
  assertConstraintsKeyed,
  assertTags,
  buildCacheControl,
  defaultCacheKey,
  durationSeconds,
  generateETag,
  isNotModified,
  parseRequestCacheControl,
  pragmaNoCache,
  storedHeadersOf,
} from './_util.js'
import type { CacheBypassReason, CacheObserver } from './observer.js'
import type { HTTPCacheEntry, HTTPCacheStore } from './store.js'
import { withStoreSignal } from './store_signal.js'

const DEFAULT_METHODS = ['GET', 'HEAD']
const DEFAULT_STATUS_CODES = [200]

// Cache-status values reported via the status header (default `X-Cache`).
const CACHE_HIT = 'HIT'
const CACHE_MISS = 'MISS'
const CACHE_BYPASS = 'BYPASS'

export type ETagGenerator = (payload: Buffer) => string | Promise<string>

export interface CacheControlOptions {
  /**
   * How long a response stays fresh: both the lifetime of the entry in the server-side store and the `max-age`
   * sent to the client. Without it nothing is stored. Must be positive.
   */
  ttl?: Duration
  /** `s-maxage`, for shared caches downstream. The server-side store goes by `ttl`. */
  sharedMaxAge?: Duration
  /** Sent as `stale-while-revalidate`, for caches downstream. The server-side store never serves stale. */
  staleWhileRevalidate?: Duration
  /** Sent as `stale-if-error`, for caches downstream. The server-side store never serves stale. */
  staleIfError?: Duration
  /**
   * Sends `no-store` on every response of the route, errors included, over a `Cache-Control` the handler wrote,
   * and stores nothing.
   */
  noStore?: boolean
  noCache?: boolean
  mustRevalidate?: boolean
  proxyRevalidate?: boolean
  noTransform?: boolean
  /**
   * `private` keeps the response out of the server-side store. `public` stores it even for an identified
   * client, and even when it sets a cookie — the cookie itself is never stored. Left unset, a request that
   * carries `Authorization`, or that an authentication scheme identified some other way, is answered as
   * `private` and not stored, and a response that sets a cookie is not stored.
   */
  privacy?: 'private' | 'public'
  immutable?: boolean
  /**
   * The request headers the response depends on. Added to the response's `Vary`, and their values become part of
   * the store key. `*` means the response is never stored.
   *
   * A route selected by a constraint — a version, a host — shares its URL with the routes selected otherwise, so
   * it must list the constraint's header here, or have its own `key`; it is refused at start-up otherwise.
   */
  vary?: string[]
  /**
   * The query parameters the response depends on. The others are left out of the store key, so `?utm_source=`
   * does not fragment the cache. `[]` leaves the whole query out. Unset, the install's `varyByQuery` applies,
   * and without one the whole query counts.
   */
  varyByQuery?: string[]
  /**
   * The tags the entry is stored under: what `@CacheInvalidate({ tags })`, and `HTTPCacheStore.evictByTag` from
   * any service, reach it by. Non-empty strings without `{` or `}`; refused at start-up otherwise.
   */
  tags?: string[]
  /** `false` sends no `ETag`. A handler's own `ETag` header is always kept, and used instead of a hash. */
  etag?: boolean
  /**
   * The request methods whose responses are cached. Defaults to `GET` and `HEAD`.
   *
   * The default key is built from the method, the URL and the `vary` headers, never the body: a `POST` listed
   * here is answered with whatever the first `POST` to that URL produced, unless `key` tells them apart.
   */
  methods?: string[]
  /**
   * The status codes whose responses are cached and replayed as they were. Defaults to `200`. A response with any
   * other status carries nothing of this policy but `noStore`.
   */
  statusCodes?: number[]
  /**
   * Derives the store key instead of the default. Eviction is by tag, so the key is the cache's own concern.
   *
   * `req` is the request of the handler's own context, so it needs a server the application's adapter drives.
   */
  key?: (req: FastifyContextRequest) => string
  /**
   * Hashes the payload into the `ETag`, instead of the one given to `HTTPCaching`. The default tag is strong and
   * computed before any content-coding.
   */
  etagGenerator?: ETagGenerator
}

/** What the cache hooks need, resolved once at start-up by `HTTPCaching`. */
export interface CacheDeps {
  store: HTTPCacheStore
  etagGenerator: ETagGenerator | undefined
  statusHeader: string
  /**
   * Called as given. `HTTPCaching` hands over one wrapped so a throw never reaches the response; a caller building
   * these itself for `cachePlugin` or `attachCacheHooks` owns that.
   */
  observer?: CacheObserver
  /**
   * Milliseconds a store call may take before the cache goes on without it, reported like a rejection. Left out,
   * a call is bounded by the request alone.
   */
  storeTimeoutMs?: number
  /** The query parameters a store key carries, for a route that does not list its own. Unset: the whole query. */
  varyByQuery?: readonly string[]
  /** Bytes. A larger payload is not stored, and `observer.onSkip` is told. Unset: no limit. */
  maxEntrySizeBytes?: number
}

/**
 * Attaches the read and store hooks to one route, per its `@CacheControl` options.
 *
 * Serves cacheable responses from and stores them into the {@link HTTPCacheStore} in `deps`, and emits
 * `Cache-Control`/`ETag`/`Vary` headers.
 *
 * A handler that writes its own `Cache-Control` has decided for that response: the header is left as written
 * and the response is not stored. `noStore` and `@CacheControl(false)` are the exceptions, and overwrite it.
 *
 * Not stored either: the response to a `HEAD`, one larger than `maxEntrySize`, and one that sets a cookie
 * unless the route is `public`; the last two are reported to `observer.onSkip`.
 *
 * A store read is bounded by the request's own signal and by `storeTimeout`; a write is bounded by
 * `storeTimeout` alone, since the entry is for the requests that follow.
 *
 * A conditional request is answered `304` in two shapes. From the store, the `304` carries only what guides a
 * cache update: `Cache-Control`, `Content-Location`, `ETag`, `Expires`, `Last-Modified` and `Vary`. When the
 * handler ran and its response matches, that response goes out as the `304`, with its own headers and without
 * its body or `Content-Length`.
 *
 * `@CacheControl(false)` gets the store hook alone — it has nothing to serve, but it still has to emit the
 * no-cache headers.
 *
 * @throws ErrConfiguration When a duration is not one, `ttl` is below one second, a tag is not a non-empty
 *   string without a brace, or the route is constrained and nothing in its key tells it from the other routes on
 *   its URL.
 */
export function attachCacheHooks(
  routeDef: AdapterRouteOptions,
  opts: CacheControlOptions | false,
  deps: CacheDeps,
): void {
  const { store, etagGenerator, statusHeader, observer, storeTimeoutMs, maxEntrySizeBytes } = deps

  // Resolved here, once per route, and only when someone is listening. Every call site below is
  // `observer?.onX?.({...})`: the optional call short-circuits before its argument is built, so an unobserved
  // route allocates no event.
  const route = observer === undefined ? undefined : cacheRouteOf(routeDef)

  if (opts === false) {
    // @CacheControl(false): actively disable caching with the full set of no-cache headers. The restrictive
    // form, so it is written over whatever the handler set.
    addRouteHook(routeDef, 'onSend', async function onSend(_request: AdapterRequest, reply: AdapterReply, payload) {
      reply.header('Cache-Control', 'no-store, max-age=0, must-revalidate, proxy-revalidate')
      reply.header('Expires', '0')
      reply.header('Pragma', 'no-cache')
      reply.header('Surrogate-Control', 'no-store')
      reply.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: route!, reason: 'disabled' })

      return payload
    })

    return
  }

  // Everything a request would otherwise work out again is worked out here, once per route.
  const read: CacheControlOptions = opts
  const methods = read.methods?.map(method => method.toUpperCase()) ?? DEFAULT_METHODS
  const statusCodes = read.statusCodes ?? DEFAULT_STATUS_CODES
  const ttlSeconds = read.ttl === undefined ? undefined : durationSeconds(routeDef, 'ttl', read.ttl, 1)

  if (read.sharedMaxAge !== undefined) {
    durationSeconds(routeDef, 'sharedMaxAge', read.sharedMaxAge, 0)
  }
  if (read.staleWhileRevalidate !== undefined) {
    durationSeconds(routeDef, 'staleWhileRevalidate', read.staleWhileRevalidate, 0)
  }
  if (read.staleIfError !== undefined) {
    durationSeconds(routeDef, 'staleIfError', read.staleIfError, 0)
  }

  assertTags(routeDef, read.tags, { what: 'caching', required: false })
  assertConstraintsKeyed(routeDef, read)

  const tags: readonly string[] | undefined = read.tags?.length ? Object.freeze([...read.tags]) : undefined
  const varyByQuery = read.varyByQuery ?? deps.varyByQuery
  const queryNames = varyByQuery === undefined ? undefined : new Set(varyByQuery)

  const policyCacheControl = buildCacheControl(read)
  const privateCacheControl = buildCacheControl(read, 'private')
  const vary = read.vary?.length ? read.vary : undefined
  const varyAny = vary?.includes('*') === true
  const statusHeaderName = statusHeader.toLowerCase()

  // The context is the one the adapter gave the request before any route hook ran: a key function reads the
  // same request the handler will, and nothing is built for it here.
  const keyOf = (request: AdapterRequest): string =>
    read.key ? read.key((request as FastifyRequest).httpContext.req) : defaultCacheKey(request, vary, queryNames)

  // Why this request's response belongs to one client, if it does. A route that says `public` has answered the
  // question; otherwise any proof of identity on the request makes it private — the `Authorization` header
  // (RFC 9111 §3.5), or a principal an authentication scheme established some other way, a session cookie for one.
  function privacyOf(request: AdapterRequest): 'private' | 'authorization' | 'authenticated' | undefined {
    if (read.privacy !== undefined) {
      return read.privacy === 'private' ? 'private' : undefined
    }

    if (request.headers.authorization) {
      return 'authorization'
    }

    // `null` until a scheme authenticates, and absent on a server the framework does not drive.
    const user = (request as FastifyRequest).user as Principal | null | undefined

    return user?.authenticated === true ? 'authenticated' : undefined
  }

  // OnRequest phase: check if the request is cacheable and return the cached response if it is
  async function onRequest(request: AdapterRequest, reply: AdapterReply) {
    if (!methods.includes(request.method)) {
      // No status header here, but the observer still hears of it: leaving it out would drop these requests from
      // every hit ratio computed off the events.
      observer?.onBypass?.({ route: route!, reason: 'method' })
      return
    }

    const privacy = privacyOf(request)
    if (privacy !== undefined) {
      reply.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: route!, reason: privacy })
      return
    }

    // RFC 9111 §4.1 — Vary: * always fails to match; never serve from cache
    if (varyAny) {
      reply.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: route!, reason: 'vary-any' })
      return
    }

    // RFC 9111 §5.2.1 — a client asking for a fresh response is not answered from the store
    const directives = parseRequestCacheControl(request.headers['cache-control'])
    const bypass: CacheBypassReason | undefined = directives.noCache
      ? 'no-cache'
      : directives.noStore
        ? 'no-store'
        : directives.maxAge === 0
          ? 'max-age-0'
          : pragmaNoCache(request)
            ? 'pragma-no-cache'
            : undefined
    if (bypass !== undefined) {
      reply.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: route!, reason: bypass })
      return
    }

    // Derived once and carried to the store hook, so the two cannot disagree on it.
    const key = keyOf(request)
    request.cacheKey = key

    let cached: HTTPCacheEntry | undefined
    try {
      cached = await withStoreSignal('get', request.signal, storeTimeoutMs, signal => store.get(key, { tags, signal }))
    } catch (error) {
      // The request is over — the client left, or Fastify has answered its handler timeout: nothing to serve,
      // nothing to report.
      if (request.signal.aborted) {
        return
      }

      // A store that is down costs the cache, not the request.
      observer?.onError?.({ route: route!, operation: 'get', error })
    }

    if (!cached) {
      if (directives.onlyIfCached) {
        observer?.onMiss?.({ route: route!, key, reason: 'only-if-cached' })
        return reply.code(504).send()
      }
      reply.header(statusHeader, CACHE_MISS)
      observer?.onMiss?.({ route: route!, key, reason: 'absent' })
      return
    }

    // RFC 9111 §4.2.3 — apparent age of the stored response, in whole seconds.
    const age = cached.storedAt ? Math.max(0, Math.floor((Date.now() - cached.storedAt) / 1000)) : 0

    // A store is trusted to expire its entries, not relied on to: one that hands back an entry past the route's
    // ttl has nothing fresh to offer.
    const expired = ttlSeconds !== undefined && age > ttlSeconds

    // RFC 9111 §5.2.1.1 — a client's max-age caps how stale a response it will accept from the cache.
    if (expired || (directives.maxAge !== undefined && age > directives.maxAge)) {
      if (directives.onlyIfCached) {
        observer?.onMiss?.({ route: route!, key, reason: 'only-if-cached' })
        return reply.code(504).send()
      }
      reply.header(statusHeader, CACHE_MISS)
      observer?.onMiss?.({ route: route!, key, reason: expired ? 'expired' : 'stale-for-request' })
      return
    }

    request.responseCached = true

    // RFC 9110 §13.2.1 — preconditions apply to GET and HEAD, and only where the answer would be a 2xx.
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      cached.statusCode >= 200 &&
      cached.statusCode < 300 &&
      isNotModified(request, cached.etag, cached.lastModified)
    ) {
      observer?.onHit?.({ route: route!, key, revalidated: true, ageSeconds: age })
      applyStoredHeaders(reply, cached.headers, true)
      return reply.code(304).header(statusHeader, CACHE_HIT).header('Age', String(age)).send()
    }

    observer?.onHit?.({ route: route!, key, revalidated: false, ageSeconds: age })
    applyStoredHeaders(reply, cached.headers, false)
    reply.status(cached.statusCode).header(statusHeader, CACHE_HIT).header('Age', String(age))

    // The payload goes out on a HEAD too: the server drops the body and keeps its length, which is the
    // Content-Length a GET would have carried (RFC 9110 §8.6).
    return reply.send(cached.payload)
  }

  // Before sending the response,
  // we need to build the cache control headers and store the response in the cache
  async function onSend(request: AdapterRequest, reply: AdapterReply, payload: unknown) {
    if (request.responseCached) {
      return payload
    }

    // On every response of the route, whatever its status (RFC 9110 §12.5.5), and added to what other plugins
    // already said the response varies on.
    if (vary !== undefined) {
      appendVary(reply, vary)
    }

    // A handler that wrote its own Cache-Control has decided for this response: it is left as written, and the
    // response is not stored under a policy it opted out of. `noStore` is the exception: the restrictive form is
    // written over whatever the handler said.
    const handlerDecides = reply.hasHeader('cache-control')

    // The policy describes the responses the route caches. Anything else — an error, a method the route does not
    // cache — gets nothing permissive from it, only the one directive that restricts.
    if (!methods.includes(request.method) || !statusCodes.includes(reply.statusCode)) {
      if (read.noStore) {
        reply.header('Cache-Control', 'no-store')
      }

      return payload
    }

    const isPrivate = privacyOf(request) !== undefined

    if (!handlerDecides || read.noStore) {
      const cacheControl = isPrivate ? privateCacheControl : policyCacheControl
      if (cacheControl) {
        reply.header('Cache-Control', cacheControl)
      }
    }

    const isStringOrBuffer = typeof payload === 'string' || Buffer.isBuffer(payload)

    // The handler's validators are the better ones — it knows the resource's version and when it changed.
    let etag = headerText(reply.getHeader('etag'))
    if (etag === undefined && read.etag !== false && !read.noStore && isStringOrBuffer) {
      etag = await generateETag(payload as string | Buffer, read.etagGenerator ?? etagGenerator)
      reply.header('ETag', etag)
    }

    const handlerLastModified = headerText(reply.getHeader('last-modified'))

    // ETag and storage are independent — etag: false must not prevent caching
    // Private responses must not be stored in the shared server-side cache
    // RFC 9111 §4.1 — Vary: * means the response must never be cached
    // RFC 9111 §5.2.1.5 — nor is the response to a request that said no-store
    // RFC 9111 §4 — nor the response to a HEAD, which shares the GET's key and may have no body to offer it
    const storable =
      ttlSeconds !== undefined &&
      request.method !== 'HEAD' &&
      !read.noStore &&
      !isPrivate &&
      !varyAny &&
      !handlerDecides &&
      isStringOrBuffer &&
      !parseRequestCacheControl(request.headers['cache-control']).noStore

    if (storable) {
      // The read hook derived it unless it returned before getting that far.
      const key = request.cacheKey ?? keyOf(request)
      const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : (payload as Buffer).length

      if (read.privacy !== 'public' && reply.hasHeader('set-cookie')) {
        // A response that sets a cookie is taken for one client's, unless the route said `public`.
        observer?.onSkip?.({ route: route!, key, reason: 'set-cookie', bytes })
      } else if (maxEntrySizeBytes !== undefined && bytes > maxEntrySizeBytes) {
        observer?.onSkip?.({ route: route!, key, reason: 'entry-too-large', bytes })
      } else {
        const lastModified = handlerLastModified ?? new Date().toUTCString()
        if (handlerLastModified === undefined) {
          reply.header('Last-Modified', lastModified)
        }

        // Bounded by `storeTimeout` alone: the entry is for the requests that follow, whatever became of this one.
        try {
          await withStoreSignal('put', undefined, storeTimeoutMs, signal =>
            store.put(
              key,
              {
                payload: payload as string | Buffer,
                statusCode: reply.statusCode,
                etag,
                lastModified,
                storedAt: Date.now(),
                headers: storedHeadersOf(reply, statusHeaderName),
              },
              { ttl: read.ttl!, tags, signal },
            ),
          )

          observer?.onStore?.({ route: route!, key, bytes, ttlSeconds, tags })
        } catch (error) {
          // Nothing was stored; the response the handler produced still goes out.
          observer?.onError?.({ route: route!, operation: 'put', error })
        }
      }
    }

    // The response just produced is the current representation, so a client that already holds it is told so.
    // The cache's own Last-Modified is left out: stamped this second, it would match a copy from earlier in the
    // same second whatever had changed since.
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300 &&
      isNotModified(request, etag, handlerLastModified)
    ) {
      reply.code(304)
      reply.removeHeader('content-length')

      return null
    }

    return payload
  }

  addRouteHook(routeDef, 'onRequest', onRequest)
  addRouteHook(routeDef, 'onSend', onSend)
}

function headerText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
