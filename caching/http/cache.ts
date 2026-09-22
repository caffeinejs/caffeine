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
  type RequestCacheControl,
} from './_util.js'
import { Flight, type FlightTable } from './flight.js'
import type { CacheBypassReason, CacheMissReason, CacheObserver } from './observer.js'
import type { HTTPCacheEntry, HTTPCacheStore } from './store.js'
import { withStoreSignal } from './store_signal.js'

/** What a hook that finishes synchronously calls, with the payload as Fastify hands it on. */
type OnSendNext = (err: Error | null, payload?: unknown) => void

const DEFAULT_METHODS = ['GET', 'HEAD']
const DEFAULT_STATUS_CODES = [200]

// Cache-status values reported via the status header (default `X-Cache`).
const CACHE_HIT = 'HIT'
const CACHE_MISS = 'MISS'
const CACHE_BYPASS = 'BYPASS'
const CACHE_STALE = 'STALE'

// RFC 5861 §4 — the responses a stale entry may stand in for.
const SIE_STATUS = new Set([500, 502, 503, 504])

export type ETagGenerator = (payload: Buffer) => string | Promise<string>

export interface CacheControlOptions {
  /**
   * How long a response stays fresh: both the lifetime of the entry in the server-side store and the `max-age`
   * sent to the client. Without it nothing is stored. Must be positive.
   */
  ttl?: Duration
  /** `s-maxage`, for shared caches downstream. The server-side store goes by `ttl`. */
  sharedMaxAge?: Duration
  /**
   * How long past `ttl` an entry may still be served while a fresh response is being produced. Sent as
   * `stale-while-revalidate`, and honoured by the server-side store too: the first request to find the entry
   * stale runs the handler, and the requests behind it are served the stale entry (`X-Cache: STALE`) until it
   * stores. Nothing without the route's lock, and never to a request whose `max-age` or `min-fresh` the entry
   * does not meet. Off under `mustRevalidate`, `proxyRevalidate` or `noCache`.
   */
  staleWhileRevalidate?: Duration
  /**
   * How long past `ttl` an entry may stand in for a `500`, `502`, `503` or `504` the handler produces. Sent as
   * `stale-if-error`, and honoured by the server-side store too: the entry goes out in the error's place, with
   * its own status and headers, marked `X-Cache: STALE`. Off under `mustRevalidate`, `proxyRevalidate` or
   * `noCache`.
   */
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
   * `false` lets every concurrent miss run the handler. On by default: the first miss for a key runs the handler
   * and the others wait, up to the install's `lockTimeout`, for what it stores. A route whose handler hijacks
   * the reply or streams should turn it off, since such a response settles nothing before the timeout.
   */
  lock?: boolean
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
   * Milliseconds a store call may take before the cache goes on without it, reported like a rejection.
   * `HTTPCaching` sets `2s` unless told otherwise; left out here, a call is bounded by the request alone.
   */
  storeTimeoutMs?: number
  /** The query parameters a store key carries, for a route that does not list its own. Unset: the whole query. */
  varyByQuery?: readonly string[]
  /** Bytes. A larger payload is not stored, and `observer.onSkip` is told. Unset: no limit. */
  maxEntrySizeBytes?: number
  /** The install's flights, one table per install. Absent, with `lockTimeoutMs`, concurrent misses each run the handler. */
  flights?: FlightTable
  /** How long a follower waits on a flight, in milliseconds. */
  lockTimeoutMs?: number
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
 * Concurrent misses for one key run the handler once. The first leads and the rest wait on its flight; when
 * it stored, they are served the entry (`coalesced` on the hit event), otherwise they run the handler themselves
 * (`not-coalesced` on the miss event). A `HEAD` never leads, since its response is never stored, but it does
 * wait. The leader settles the flight from its store hook, and a flight settles itself at `lockTimeout` for a
 * leader whose store hook never runs.
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
  const { store, etagGenerator, statusHeader, observer, storeTimeoutMs, maxEntrySizeBytes, flights, lockTimeoutMs } =
    deps

  // Resolved here, once per route, and only when someone is listening. Every call site below is
  // `observer?.onX?.({...})`: the optional call short-circuits before its argument is built, so an unobserved
  // route allocates no event.
  const route = observer === undefined ? undefined : cacheRouteOf(routeDef)

  if (opts === false) {
    // @CacheControl(false): actively disable caching with the full set of no-cache headers. The restrictive
    // form, so it is written over whatever the handler set.
    addRouteHook(routeDef, 'onSend', function onSend(_request, reply, payload, next: OnSendNext) {
      reply.header('Cache-Control', 'no-store, max-age=0, must-revalidate, proxy-revalidate')
      reply.header('Expires', '0')
      reply.header('Pragma', 'no-cache')
      reply.header('Surrogate-Control', 'no-store')
      reply.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: route!, reason: 'disabled' })

      next(null, payload)
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
  const swrDeclared =
    read.staleWhileRevalidate === undefined
      ? undefined
      : durationSeconds(routeDef, 'staleWhileRevalidate', read.staleWhileRevalidate, 0)
  const sieDeclared =
    read.staleIfError === undefined ? undefined : durationSeconds(routeDef, 'staleIfError', read.staleIfError, 0)

  // RFC 9111 §4.2.4 — a response that must be revalidated is never served stale, whatever window it names.
  const staleAllowed = !read.mustRevalidate && !read.proxyRevalidate && !read.noCache
  const swrSeconds = staleAllowed ? swrDeclared : undefined
  const sieSeconds = staleAllowed ? sieDeclared : undefined

  // What the store keeps the entry for: the freshness lifetime, and the longest stale window after it.
  const retentionSeconds =
    ttlSeconds === undefined ? undefined : ttlSeconds + Math.max(swrSeconds ?? 0, sieSeconds ?? 0)

  assertTags(routeDef, read.tags, { what: 'caching', required: false })
  assertConstraintsKeyed(routeDef, read)

  const tags: readonly string[] | undefined = read.tags?.length ? Object.freeze([...read.tags]) : undefined
  const varyByQuery = read.varyByQuery ?? deps.varyByQuery
  const queryNames = varyByQuery === undefined ? undefined : new Set(varyByQuery)

  // A route that can never store never creates a flight: followers would wait for nothing.
  const lockable =
    read.lock !== false &&
    flights !== undefined &&
    lockTimeoutMs !== undefined &&
    ttlSeconds !== undefined &&
    !read.noStore

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
    let readFailed = false
    try {
      cached = await withStoreSignal('get', request.signal, storeTimeoutMs, signal => store.get(key, { tags, signal }))
    } catch (error) {
      // The request is over — the client left, or Fastify has answered its handler timeout: nothing to serve,
      // nothing to report.
      if (request.signal.aborted) {
        return
      }

      // A store that is down costs the cache, not the request.
      readFailed = true
      observer?.onError?.({ route: route!, operation: 'get', error })
    }

    if (cached !== undefined) {
      const age = ageOf(cached)
      if (accepts(age, directives)) {
        return serve(request, reply, cached, age, false, false)
      }

      if (!expired(age)) {
        return miss(request, reply, key, directives, 'stale-for-request', !readFailed)
      }

      // Past its ttl, yet not past what the route allows: kept for the store hook to replay over a 5xx, and
      // served as it is to whoever arrives while the handler is already running for this key.
      if (requestAccepts(age, directives) && !directives.onlyIfCached) {
        if (sieSeconds !== undefined && age <= ttlSeconds! + sieSeconds) {
          request.cacheStale = cached
        }
        if (swrSeconds !== undefined && age <= ttlSeconds! + swrSeconds && lockable && !readFailed) {
          const flight = flights!.get(key)
          if (flight !== undefined) {
            return serve(request, reply, cached, age, false, true)
          }
        }
      }

      return miss(request, reply, key, directives, 'expired', !readFailed)
    }

    return miss(request, reply, key, directives, 'absent', !readFailed)
  }

  // RFC 9111 §4.2.3 — apparent age of the stored response, in whole seconds.
  function ageOf(entry: HTTPCacheEntry): number {
    return entry.storedAt ? Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000)) : 0
  }

  // A store is trusted to expire its entries, not relied on to: one that hands back an entry past the route's
  // ttl has nothing fresh to offer.
  function expired(age: number): boolean {
    return ttlSeconds !== undefined && age > ttlSeconds
  }

  // RFC 9111 §5.2.1.1 and §5.2.1.3 — a client's max-age caps the age it accepts, and its min-fresh the freshness
  // it wants left. Neither is a reason to serve stale.
  function requestAccepts(age: number, directives: RequestCacheControl): boolean {
    return (
      (directives.maxAge === undefined || age <= directives.maxAge) &&
      (directives.minFresh === undefined || ttlSeconds === undefined || age + directives.minFresh <= ttlSeconds)
    )
  }

  function accepts(age: number, directives: RequestCacheControl): boolean {
    return !expired(age) && requestAccepts(age, directives)
  }

  // Nothing to serve. A miss either joins the flight already running the handler for this key, or starts one and
  // runs the handler itself. A miss the store could not even be asked about does neither: there would be nothing
  // for a follower to read.
  async function miss(
    request: AdapterRequest,
    reply: AdapterReply,
    key: string,
    directives: RequestCacheControl,
    reason: CacheMissReason,
    canJoin: boolean,
  ): Promise<unknown> {
    if (directives.onlyIfCached) {
      observer?.onMiss?.({ route: route!, key, reason: 'only-if-cached' })
      return reply.code(504).send()
    }

    if (lockable && canJoin) {
      const flight = flights!.get(key)
      if (flight !== undefined) {
        return follow(request, reply, key, directives, flight)
      }

      // A HEAD never leads: its response is never stored, so it would release its followers to nothing.
      if (request.method !== 'HEAD') {
        request.cacheFlight = new Flight(flights!, key, lockTimeoutMs!)
      }
    }

    reply.header(statusHeader, CACHE_MISS)
    observer?.onMiss?.({ route: route!, key, reason })

    return
  }

  async function follow(
    request: AdapterRequest,
    reply: AdapterReply,
    key: string,
    directives: RequestCacheControl,
    flight: Flight,
  ): Promise<unknown> {
    const outcome = await flight.done
    if (outcome !== 'not-stored') {
      let again: HTTPCacheEntry | undefined
      try {
        again = await withStoreSignal('get', request.signal, storeTimeoutMs, signal => store.get(key, { tags, signal }))
      } catch (error) {
        if (request.signal.aborted) {
          return
        }

        observer?.onError?.({ route: route!, operation: 'get', error })
      }

      if (again !== undefined) {
        const age = ageOf(again)
        if (accepts(age, directives)) {
          return serve(request, reply, again, age, true, false)
        }

        // The leader was answered with the stale entry in place of its 5xx: so is a follower it still covers.
        if (
          outcome === 'rescued' &&
          sieSeconds !== undefined &&
          expired(age) &&
          age <= ttlSeconds! + sieSeconds &&
          requestAccepts(age, directives)
        ) {
          return serve(request, reply, again, age, true, true)
        }
      }
    }

    // What the leader did is no use to this request: it runs the handler itself, and leads nobody.
    reply.header(statusHeader, CACHE_MISS)
    observer?.onMiss?.({ route: route!, key, reason: 'not-coalesced' })

    return
  }

  function serve(
    request: AdapterRequest,
    reply: AdapterReply,
    cached: HTTPCacheEntry,
    age: number,
    coalesced: boolean,
    stale: boolean,
  ): unknown {
    request.responseCached = true
    const status = stale ? CACHE_STALE : CACHE_HIT

    // RFC 9110 §13.2.1 — preconditions apply to GET and HEAD, and only where the answer would be a 2xx.
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      cached.statusCode >= 200 &&
      cached.statusCode < 300 &&
      isNotModified(request, cached.etag, cached.lastModified)
    ) {
      observer?.onHit?.({ route: route!, key: request.cacheKey!, revalidated: true, ageSeconds: age, coalesced, stale })
      applyStoredHeaders(reply, cached.headers, 'revalidation')
      return reply.code(304).header(statusHeader, status).header('Age', String(age)).send()
    }

    observer?.onHit?.({ route: route!, key: request.cacheKey!, revalidated: false, ageSeconds: age, coalesced, stale })
    applyStoredHeaders(reply, cached.headers, 'hit')
    reply.status(cached.statusCode).header(statusHeader, status).header('Age', String(age))

    // The payload goes out on a HEAD too: the server drops the body and keeps its length, which is the
    // Content-Length a GET would have carried (RFC 9110 §8.6).
    return reply.send(cached.payload)
  }

  // The store hook: emits the cache headers and stores the response. A leader settles its flight here, whatever
  // happened — `stored` once the write landed, `not-stored` on every other way out, the throw included.
  //
  // Fastify runs a hook on the promise it hands back, or on the `next` it calls. A response the policy caches
  // awaits the store; every other one is finished here and now, so a response Fastify sends while this route's
  // read hook is still waiting on the store — its handler timeout's 503 — is over before that hook returns, and
  // the lifecycle stops there instead of sending a second time.
  function onSend(
    request: AdapterRequest,
    reply: AdapterReply,
    payload: unknown,
    next: OnSendNext,
  ): void | Promise<unknown> {
    if (request.responseCached) {
      next(null, payload)
      return
    }

    // RFC 5861 §4 — the stale entry the read hook kept stands in for the handler's 5xx.
    const stale = request.cacheStale
    if (stale !== null && SIE_STATUS.has(reply.statusCode)) {
      next(null, replace(request, reply, stale))
      return
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

      request.cacheFlight?.settle('not-stored')
      next(null, payload)
      return
    }

    return send(request, reply, payload, handlerDecides).finally(() => request.cacheFlight?.settle('not-stored'))
  }

  // The entry goes out as it was stored: its status, its headers over the error's, its payload. `Content-Length`
  // is removed so the server computes it from the new payload; `Retry-After` belonged to the error. A HEAD gets
  // the entry's length and no body: Fastify's own HEAD hook has already dropped the error's body and runs ahead
  // of this one. Nothing is stored, and the leader's followers are told a stale entry was served in its place.
  function replace(request: AdapterRequest, reply: AdapterReply, stale: HTTPCacheEntry): unknown {
    const replaced = reply.statusCode
    const age = ageOf(stale)

    reply.code(stale.statusCode)
    reply.removeHeader('content-length')
    reply.removeHeader('retry-after')
    applyStoredHeaders(reply, stale.headers, 'replacement')
    reply.header(statusHeader, CACHE_STALE).header('Age', String(age))
    request.cacheFlight?.settle('rescued')
    observer?.onStaleIfError?.({ route: route!, key: request.cacheKey!, ageSeconds: age, replaced })

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      stale.statusCode >= 200 &&
      stale.statusCode < 300 &&
      isNotModified(request, stale.etag, stale.lastModified)
    ) {
      reply.code(304)
      return null
    }

    if (request.method === 'HEAD') {
      const length = typeof stale.payload === 'string' ? Buffer.byteLength(stale.payload) : stale.payload.length
      reply.header('Content-Length', String(length))
      return null
    }

    return stale.payload
  }

  async function send(
    request: AdapterRequest,
    reply: AdapterReply,
    payload: unknown,
    handlerDecides: boolean,
  ): Promise<unknown> {
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
              { ttl: retentionSeconds!, tags, signal },
            ),
          )

          request.cacheFlight?.settle('stored')
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
