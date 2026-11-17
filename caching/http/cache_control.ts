import {
  appendVary,
  withholdValidators,
  type IContext,
  type Principal,
  type RouteDefinition,
  type SendPayload,
} from '@caffeinejs/http'
import type { ByteSize } from '@caffeinejs/std/bytes'
import { type Duration, Second } from '@caffeinejs/std/duration'

import { cacheRouteResolver } from './_observe.js'
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

const DEFAULT_METHODS = ['GET', 'HEAD']
const DEFAULT_STATUS_CODES = [200]

// Cache-status values reported via the status header (default `X-Cache`).
const CACHE_HIT = 'HIT'
const CACHE_MISS = 'MISS'
const CACHE_BYPASS = 'BYPASS'
const CACHE_STALE = 'STALE'

// RFC 5861 §4 — the responses a stale entry may stand in for.
const SIE_STATUS = new Set([500, 502, 503, 504])

export type ETagGenerator = (payload: Uint8Array) => string | Promise<string>

export interface CacheControlOptions {
  /**
   * How long a response stays fresh: the `max-age` sent to the client, and how long the server-side store serves
   * the entry as fresh; the store keeps it that long plus the longest of `staleWhileRevalidate` and
   * `staleIfError`. Without it nothing is stored. At least one second.
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
   * and the others wait, up to the install's `lockTimeout`, for what it stores. A route whose response is ended
   * outside the server, or streams, should turn it off, since such a response settles nothing before the timeout.
   */
  lock?: boolean
  /**
   * The request methods whose responses are cached. Defaults to `GET` and `HEAD`.
   *
   * The default key is built from the method, the URL with its query and the `vary` headers, never the body: a `POST` listed

   * here is answered with whatever the first `POST` to that URL produced, unless `key` tells them apart.
   */
  methods?: string[]
  /**
   * The status codes whose responses are cached and replayed as they were. Defaults to `200`. A response with any
   * other status carries nothing of this policy but `noStore`.
   */
  statusCodes?: number[]
  /** Derives the store key instead of the default. Eviction is by tag, so the key is the cache's own concern. */
  key?: (req: IContext['req']) => string
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
   * How long a store call may take before the cache goes on without it, reported like a rejection.
   * `HTTPCaching` sets two seconds unless told otherwise; left out here, a call is bounded by the request alone.
   */
  storeTimeout?: Duration
  /** The query parameters a store key carries, for a route that does not list its own. Unset: the whole query. */
  varyByQuery?: readonly string[]
  /** The largest payload stored. A larger payload is not stored, and `observer.onSkip` is told. Unset: no limit. */
  maxEntrySize?: ByteSize
  /** The install's flights, one table per install. Absent, with `lockTimeout`, concurrent misses each run the handler. */
  flights?: FlightTable
  /** How long a follower waits on a flight. */
  lockTimeout?: Duration
}

/** What the read hook leaves for the store hook of the same request. */
interface CacheRequestState {
  /** Served or `304`'d from the store, so the store hook skips. */
  cached: boolean
  /** The store key the read hook derived, which the store hook writes under. */
  key: string | null
  /**
   * The flight this request leads, so its store hook settles it — this one, never a newer flight under the same
   * key.
   */
  flight: Flight | null
  /** A stale entry the read hook found within `staleIfError`, for the store hook to replay over a 5xx. */
  stale: HTTPCacheEntry | null
  /** Puts back the validators a miss withheld from the handler, so the store hook answers them. */
  restore: (() => void) | null
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
 * Not stored either: the response to a `HEAD`, one larger than `maxEntrySize`, one that sets a cookie unless
 * the route is `public`, a stream, and one with no body at all; the last four are reported to `observer.onSkip`.

 *
 * A store read is bounded by the request's own signal and by `storeTimeout`; a write is bounded by
 * `storeTimeout` alone, since the entry is for the requests that follow.
 *
 * Concurrent misses for one key run the handler once. The first leads and the rest wait on its flight; when
 * it stored, they are served the entry (`coalesced` on the hit event), otherwise they run the handler themselves
 * (`not-coalesced` on the miss event). A `HEAD` never leads, since its response is never stored, but it does
 * wait. The leader settles the flight from its store hook, and a flight settles itself at `lockTimeout` for a
 * leader whose store hook never runs. A follower whose own request ends first stops waiting.
 *
 * A conditional request is answered `304` in two shapes. From the store, the `304` carries only what guides a
 * cache update: `Cache-Control`, `Content-Location`, `ETag`, `Expires`, `Last-Modified` and `Vary`. When the
 * handler ran and its response matches, that response goes out as the `304`, with its own headers and without
 * its body or `Content-Length`; a streamed body is closed unread, and so is a streamed `5xx` a stale entry
 * replaces. On a `HEAD` the server drops the body after these hooks run, keeping its length.
 *
 * `@CacheControl(false)` gets the store hook alone — it has nothing to serve, but it still has to emit the
 * no-cache headers.
 *
 * @throws ErrConfiguration When a duration is not one, `ttl` is below one second, a tag is not a non-empty
 *   string without a brace, or the route is constrained and nothing in its key tells it from the other routes on
 *   its URL.
 */
export function attachCacheHooks(route: RouteDefinition, opts: CacheControlOptions | false, deps: CacheDeps): void {
  const { store, etagGenerator, statusHeader, observer, storeTimeout, maxEntrySize, flights, lockTimeout } = deps

  // Resolved here, once per route. Every call site below is `observer?.onX?.({...})`: the optional call
  // short-circuits before its argument is built, so an unobserved route allocates no event.
  const routeOf = cacheRouteResolver(route)

  if (opts === false) {
    // @CacheControl(false): actively disable caching with the full set of no-cache headers. The restrictive
    // form, so it is written over whatever the handler set.
    route.hook('onSend', ctx => {
      ctx.header('Cache-Control', 'no-store, max-age=0, must-revalidate, proxy-revalidate')
      ctx.header('Expires', '0')
      ctx.header('Pragma', 'no-cache')
      ctx.header('Surrogate-Control', 'no-store')
      ctx.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: routeOf(ctx), reason: 'disabled' })
    })

    return
  }

  // Everything a request would otherwise work out again is worked out here, once per route.
  const read: CacheControlOptions = opts
  const methods = read.methods?.map(method => method.toUpperCase()) ?? DEFAULT_METHODS
  const statusCodes = read.statusCodes ?? DEFAULT_STATUS_CODES
  const ttlSeconds = read.ttl === undefined ? undefined : durationSeconds(route, 'ttl', read.ttl, 1)

  if (read.sharedMaxAge !== undefined) {
    durationSeconds(route, 'sharedMaxAge', read.sharedMaxAge, 0)
  }
  const swrDeclared =
    read.staleWhileRevalidate === undefined
      ? undefined
      : durationSeconds(route, 'staleWhileRevalidate', read.staleWhileRevalidate, 0)
  const sieDeclared =
    read.staleIfError === undefined ? undefined : durationSeconds(route, 'staleIfError', read.staleIfError, 0)

  // RFC 9111 §4.2.4 — a response that must be revalidated is never served stale, whatever window it names.
  const staleAllowed = !read.mustRevalidate && !read.proxyRevalidate && !read.noCache
  const swrSeconds = staleAllowed ? swrDeclared : undefined
  const sieSeconds = staleAllowed ? sieDeclared : undefined

  // What the store keeps the entry for: the freshness lifetime, and the longest stale window after it.
  const retentionSeconds =
    ttlSeconds === undefined ? undefined : ttlSeconds + Math.max(swrSeconds ?? 0, sieSeconds ?? 0)

  assertTags(route, read.tags, { what: 'caching', required: false })
  assertConstraintsKeyed(route, read)

  const tags: readonly string[] | undefined = read.tags?.length ? Object.freeze([...read.tags]) : undefined
  const varyByQuery = read.varyByQuery ?? deps.varyByQuery
  const queryNames = varyByQuery === undefined ? undefined : new Set(varyByQuery)

  // A route that can never store never creates a flight: followers would wait for nothing.
  const lockable =
    read.lock !== false &&
    flights !== undefined &&
    lockTimeout !== undefined &&
    ttlSeconds !== undefined &&
    !read.noStore

  const policyCacheControl = buildCacheControl(read)
  const privateCacheControl = buildCacheControl(read, 'private')
  const vary = read.vary?.length ? read.vary : undefined
  const varyAny = vary?.includes('*') === true
  const statusHeaderName = statusHeader.toLowerCase()

  // One request's state, from its read hook to its store hook. Created on the first write: a request the read hook
  // leaves alone allocates nothing.
  const states = new WeakMap<IContext, CacheRequestState>()

  function stateOf(ctx: IContext): CacheRequestState {
    let state = states.get(ctx)
    if (state === undefined) {
      state = { cached: false, key: null, flight: null, stale: null, restore: null }
      states.set(ctx, state)
    }
    return state
  }

  // A key function reads the same request the handler will.
  const keyOf = (ctx: IContext): string => (read.key ? read.key(ctx.req) : defaultCacheKey(ctx.req, vary, queryNames))

  // Why this request's response belongs to one client, if it does. A route that says `public` has answered the
  // question; otherwise any proof of identity on the request makes it private — the `Authorization` header
  // (RFC 9111 §3.5), or a principal an authentication scheme established some other way, a session cookie for one.
  function privacyOf(ctx: IContext): 'private' | 'authorization' | 'authenticated' | undefined {
    if (read.privacy !== undefined) {
      return read.privacy === 'private' ? 'private' : undefined
    }

    if (ctx.req.header('authorization')) {
      return 'authorization'
    }

    // `null` until a scheme authenticates.
    const user = ctx.user as Principal | null

    return user?.authenticated === true ? 'authenticated' : undefined
  }

  // OnRequest phase: check if the request is cacheable and return the cached response if it is
  async function onRequest(ctx: IContext): Promise<void> {
    if (!methods.includes(ctx.req.method)) {
      // No status header here, but the observer still hears of it: leaving it out would drop these requests from
      // every hit ratio computed off the events.
      observer?.onBypass?.({ route: routeOf(ctx), reason: 'method' })
      return
    }

    const privacy = privacyOf(ctx)
    if (privacy !== undefined) {
      ctx.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: routeOf(ctx), reason: privacy })
      return
    }

    // RFC 9111 §4.1 — Vary: * always fails to match; never serve from cache
    if (varyAny) {
      ctx.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: routeOf(ctx), reason: 'vary-any' })
      return
    }

    // RFC 9111 §5.2.1 — a client asking for a fresh response is not answered from the store
    const directives = parseRequestCacheControl(ctx.req.header('cache-control'))
    const bypass: CacheBypassReason | undefined = directives.noCache
      ? 'no-cache'
      : directives.noStore
        ? 'no-store'
        : directives.maxAge === 0
          ? 'max-age-0'
          : pragmaNoCache(ctx.req)
            ? 'pragma-no-cache'
            : undefined
    if (bypass !== undefined) {
      ctx.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: routeOf(ctx), reason: bypass })
      return
    }

    // RFC 9111 §4.3.2 — If-Match and If-Unmodified-Since are not a cache's to evaluate: answered from the store, a
    // precondition that no longer holds would get the stored 200 instead of the handler's 412. A request for the store
    // alone (§5.2.1.7) never reaches the handler that evaluates them, and no stored answer is consistent with them
    if (ctx.req.header('if-match') !== undefined || ctx.req.header('if-unmodified-since') !== undefined) {
      if (directives.onlyIfCached) {
        observer?.onMiss?.({ route: routeOf(ctx), key: keyOf(ctx), reason: 'only-if-cached' })
        ctx.status(504).body()
        return
      }

      ctx.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: routeOf(ctx), reason: 'precondition' })
      return
    }

    // RFC 9110 §14.2 — a stored whole response does not answer a request for part of one; the handler does. A
    // request for the store alone is answered from it whole, which a server may send in place of a part.
    if (ctx.req.header('range') !== undefined && !directives.onlyIfCached) {
      ctx.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: routeOf(ctx), reason: 'range' })
      return
    }

    // Derived once and carried to the store hook, so the two cannot disagree on it.
    const key = keyOf(ctx)
    stateOf(ctx).key = key

    let cached: HTTPCacheEntry | undefined
    let readFailed = false
    try {
      cached = await withStoreSignal('get', ctx.signal, storeTimeout, signal => store.get(key, { tags, signal }))
    } catch (error) {
      // The request is over — the client left, or the server has answered its handler timeout: nothing to serve,
      // nothing to report.
      if (ctx.signal.aborted) {
        return
      }

      // A store that is down costs the cache, not the request.
      readFailed = true
      observer?.onError?.({ route: routeOf(ctx), operation: 'get', error })
    }

    // A store that does not honour the signal may answer after the request ended — its client left, or its handler
    // timeout answered it — and a run started for it then may have no store hook to settle it.
    if (ctx.signal.aborted) {
      return
    }

    if (cached !== undefined) {
      const age = ageOf(cached)
      if (accepts(age, directives)) {
        return serve(ctx, cached, age, false, false)
      }

      if (!expired(age)) {
        return miss(ctx, key, directives, 'stale-for-request', !readFailed)
      }

      // Past its ttl, yet not past what the route allows.
      if (requestAccepts(age, directives)) {
        // RFC 9111 §5.2.1.2 — a client that accepts a stale entry takes the one the route keeps, at once, and
        // waits on nobody; an `only-if-cached` request too. Never where the route requires revalidation.
        if (
          staleAllowed &&
          directives.maxStale !== undefined &&
          age - ttlSeconds! <= directives.maxStale &&
          age <= retentionSeconds!
        ) {
          return serve(ctx, cached, age, false, true)
        }

        // Kept for the store hook to replay over a 5xx, and served as it is to whoever arrives while the handler
        // is already running for this key.
        if (!directives.onlyIfCached) {
          if (sieSeconds !== undefined && age <= ttlSeconds! + sieSeconds) {
            stateOf(ctx).stale = cached
          }
          if (swrSeconds !== undefined && age <= ttlSeconds! + swrSeconds && lockable && !readFailed) {
            const flight = flights!.get(key)
            if (flight !== undefined) {
              return serve(ctx, cached, age, false, true)
            }
          }
        }
      }

      return miss(ctx, key, directives, 'expired', !readFailed)
    }

    return miss(ctx, key, directives, 'absent', !readFailed)
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
    ctx: IContext,
    key: string,
    directives: RequestCacheControl,
    reason: CacheMissReason,
    canJoin: boolean,
  ): Promise<void> {
    if (directives.onlyIfCached) {
      observer?.onMiss?.({ route: routeOf(ctx), key, reason: 'only-if-cached' })
      ctx.status(504).body()
      return
    }

    if (lockable && canJoin) {
      const flight = flights!.get(key)
      if (flight !== undefined) {
        return follow(ctx, key, directives, flight)
      }

      // A HEAD never leads: its response is never stored, so it would release its followers to nothing.
      if (ctx.req.method !== 'HEAD') {
        stateOf(ctx).flight = new Flight(flights!, key, lockTimeout!)
      }
    }

    // RFC 9111 §4.3.1 — a miss that may be stored asks the handler for the whole response, not a 304 of its own,
    // which would leave nothing to store: the store hook answers the client's validators from that response.
    if (
      ctx.req.method !== 'HEAD' &&
      ttlSeconds !== undefined &&
      !read.noStore &&
      (ctx.req.hasHeader('if-none-match') || ctx.req.hasHeader('if-modified-since'))
    ) {
      stateOf(ctx).restore = withholdValidators(ctx)
    }

    ctx.header(statusHeader, CACHE_MISS)
    observer?.onMiss?.({ route: routeOf(ctx), key, reason })
  }

  async function follow(ctx: IContext, key: string, directives: RequestCacheControl, flight: Flight): Promise<void> {
    const outcome = await flight.wait(ctx.signal)

    // The request is over — the client left, or the server has answered its handler timeout: nothing to serve,
    // nobody to tell.
    if (outcome === undefined) {
      return
    }

    if (outcome !== 'not-stored') {
      let again: HTTPCacheEntry | undefined
      try {
        again = await withStoreSignal('get', ctx.signal, storeTimeout, signal => store.get(key, { tags, signal }))
      } catch (error) {
        if (ctx.signal.aborted) {
          return
        }

        observer?.onError?.({ route: routeOf(ctx), operation: 'get', error })
      }

      if (ctx.signal.aborted) {
        return
      }

      if (again !== undefined) {
        const age = ageOf(again)
        if (accepts(age, directives)) {
          return serve(ctx, again, age, true, false)
        }

        // The leader was answered with the stale entry in place of its 5xx: so is a follower it still covers.
        if (
          outcome === 'rescued' &&
          sieSeconds !== undefined &&
          expired(age) &&
          age <= ttlSeconds! + sieSeconds &&
          requestAccepts(age, directives)
        ) {
          return serve(ctx, again, age, true, true)
        }
      }
    }

    // What the leader did is no use to this request: it runs the handler itself, and leads nobody.
    ctx.header(statusHeader, CACHE_MISS)
    observer?.onMiss?.({ route: routeOf(ctx), key, reason: 'not-coalesced' })
  }

  function serve(ctx: IContext, cached: HTTPCacheEntry, age: number, coalesced: boolean, stale: boolean): void {
    const state = stateOf(ctx)
    state.cached = true
    const status = stale ? CACHE_STALE : CACHE_HIT

    // RFC 9110 §13.2.1 — preconditions apply to GET and HEAD, and only where the answer would be a 2xx.
    if (
      (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') &&
      cached.statusCode >= 200 &&
      cached.statusCode < 300 &&
      isNotModified(ctx.req, cached.etag, cached.lastModified)
    ) {
      observer?.onHit?.({
        route: routeOf(ctx),
        key: state.key!,
        revalidated: true,
        age: age * Second,
        coalesced,
        stale,
      })
      applyStoredHeaders(ctx, cached.headers, 'revalidation')
      ctx.status(304).header(statusHeader, status).header('Age', String(age)).body()
      return
    }

    observer?.onHit?.({
      route: routeOf(ctx),
      key: state.key!,
      revalidated: false,
      age: age * Second,
      coalesced,
      stale,
    })
    applyStoredHeaders(ctx, cached.headers, 'hit')

    // The payload goes out on a HEAD too: the server drops the body and keeps its length, which is the
    // Content-Length a GET would have carried (RFC 9110 §8.6).
    ctx.status(cached.statusCode).header(statusHeader, status).header('Age', String(age)).body(cached.payload)
  }

  // The store hook: emits the cache headers and stores the response. A leader settles its flight here, whatever
  // happened — `stored` once the write landed, `not-stored` on every other way out, the throw included.
  //
  // A response the policy caches awaits the store; every other one is finished here and now, so a response the
  // server sends while this route's read hook is still waiting on the store — its handler timeout's 503 — goes
  // out without waiting on it.
  function onSend(ctx: IContext, payload: SendPayload): SendPayload | void | Promise<SendPayload | void> {
    const state = states.get(ctx)
    if (state?.cached) {
      return
    }

    state?.restore?.()

    // RFC 5861 §4 — the stale entry the read hook kept stands in for the handler's 5xx.
    const stale = state?.stale ?? null
    if (stale !== null && SIE_STATUS.has(ctx.statusCode)) {
      discard(payload)
      return replace(ctx, state!, stale)
    }

    // On every response of the route, whatever its status (RFC 9110 §12.5.5), and added to what other plugins
    // already said the response varies on.
    if (vary !== undefined) {
      appendVary(ctx, vary)
    }

    // A handler that wrote its own Cache-Control has decided for this response: it is left as written, and the
    // response is not stored under a policy it opted out of. `noStore` is the exception: the restrictive form is
    // written over whatever the handler said.
    const handlerDecides = ctx.hasHeader('cache-control')

    // The policy describes the responses the route caches. Anything else — an error, a method the route does not
    // cache, a part of a body, whatever `statusCodes` lists — gets nothing permissive from it, only the one directive
    // that restricts. A part answers one request only, and stored under the whole's key it would answer the next.
    const part = ctx.statusCode === 206 || ctx.hasHeader('content-range')
    if (!methods.includes(ctx.req.method) || !statusCodes.includes(ctx.statusCode) || part) {
      if (read.noStore) {
        ctx.header('Cache-Control', 'no-store')
      }

      state?.flight?.settle('not-stored')
      return
    }

    return send(ctx, state, payload, handlerDecides).finally(() => state?.flight?.settle('not-stored'))
  }

  // The entry goes out as it was stored: its status, its headers over the error's, its payload. `Retry-After`
  // belonged to the error. On a HEAD the server drops the payload after this hook and keeps its length. Nothing is
  // stored, and the leader's followers are told a stale entry was served in its place.
  function replace(ctx: IContext, state: CacheRequestState, stale: HTTPCacheEntry): SendPayload {
    const replaced = ctx.statusCode
    const age = ageOf(stale)

    ctx.status(stale.statusCode)
    ctx.removeHeader('retry-after')
    applyStoredHeaders(ctx, stale.headers, 'replacement')
    ctx.header(statusHeader, CACHE_STALE).header('Age', String(age))
    state.flight?.settle('rescued')
    observer?.onStaleIfError?.({ route: routeOf(ctx), key: state.key!, age: age * Second, replaced })

    if (
      (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') &&
      stale.statusCode >= 200 &&
      stale.statusCode < 300 &&
      isNotModified(ctx.req, stale.etag, stale.lastModified)
    ) {
      ctx.status(304)
      return null
    }

    return stale.payload
  }

  async function send(
    ctx: IContext,
    state: CacheRequestState | undefined,
    payload: SendPayload,
    handlerDecides: boolean,
  ): Promise<SendPayload | void> {
    const isPrivate = privacyOf(ctx) !== undefined

    if (!handlerDecides || read.noStore) {
      const cacheControl = isPrivate ? privateCacheControl : policyCacheControl
      if (cacheControl) {
        ctx.header('Cache-Control', cacheControl)
      }
    }

    const isBody = typeof payload === 'string' || payload instanceof Uint8Array

    // The handler's validators are the better ones — it knows the resource's version and when it changed.
    let etag = ctx.getHeader('etag')
    if (etag === undefined && read.etag !== false && !read.noStore && isBody) {
      etag = await generateETag(payload, read.etagGenerator ?? etagGenerator)
      ctx.header('ETag', etag)
    }

    const handlerLastModified = ctx.getHeader('last-modified')

    // ETag and storage are independent — etag: false must not prevent caching
    // Private responses must not be stored in the shared server-side cache
    // RFC 9111 §4.1 — Vary: * means the response must never be cached
    // RFC 9111 §5.2.1.5 — nor is the response to a request that said no-store
    // RFC 9111 §4 — nor the response to a HEAD, which shares the GET's key and may have no body to offer it
    const wanted =
      ttlSeconds !== undefined &&
      ctx.req.method !== 'HEAD' &&
      !read.noStore &&
      !isPrivate &&
      !varyAny &&
      !handlerDecides &&
      !parseRequestCacheControl(ctx.req.header('cache-control')).noStore

    // A stream is neither hashed nor stored — a handler's, or one an earlier `onSend` hook made — and the observer is
    // told, since the response would have been stored otherwise.
    if (wanted && payload instanceof ReadableStream) {
      observer?.onSkip?.({ route: routeOf(ctx), key: state?.key ?? keyOf(ctx), reason: 'stream' })
    }

    // A handler that returned nothing: the server sends an empty body, and there is nothing to hash or replay.
    // Reported, since the route asked for the response to be stored and it will be a miss again next time.
    if (wanted && payload === null) {
      observer?.onSkip?.({ route: routeOf(ctx), key: state?.key ?? keyOf(ctx), reason: 'empty', size: 0 })
    }

    if (wanted && isBody) {
      // The read hook derived it unless it returned before getting that far.
      const key = state?.key ?? keyOf(ctx)
      const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength

      if (read.privacy !== 'public' && ctx.hasHeader('set-cookie')) {
        // A response that sets a cookie is taken for one client's, unless the route said `public`.
        observer?.onSkip?.({ route: routeOf(ctx), key, reason: 'set-cookie', size })
      } else if (maxEntrySize !== undefined && size > maxEntrySize) {
        observer?.onSkip?.({ route: routeOf(ctx), key, reason: 'entry-too-large', size })
      } else {
        const lastModified = handlerLastModified ?? new Date().toUTCString()
        if (handlerLastModified === undefined) {
          ctx.header('Last-Modified', lastModified)
        }

        // Bounded by `storeTimeout` alone: the entry is for the requests that follow, whatever became of this one.
        try {
          await withStoreSignal('put', undefined, storeTimeout, signal =>
            store.put(
              key,
              {
                payload,
                statusCode: ctx.statusCode,
                etag,
                lastModified,
                storedAt: Date.now(),
                headers: storedHeadersOf(ctx, statusHeaderName),
              },
              { ttl: retentionSeconds! * Second, tags, signal },
            ),
          )

          state?.flight?.settle('stored')
          observer?.onStore?.({ route: routeOf(ctx), key, size, ttl: read.ttl!, tags })
        } catch (error) {
          // Nothing was stored; the response the handler produced still goes out.
          observer?.onError?.({ route: routeOf(ctx), operation: 'put', error })
        }
      }
    }

    // The response just produced is the current representation, so a client that already holds it is told so.
    // The cache's own Last-Modified is left out: stamped this second, it would match a copy from earlier in the
    // same second whatever had changed since.
    if (
      (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') &&
      ctx.statusCode >= 200 &&
      ctx.statusCode < 300 &&
      isNotModified(ctx.req, etag, handlerLastModified)
    ) {
      ctx.status(304)
      discard(payload)

      return null
    }

    return payload
  }

  route.hook('onRequest', onRequest)
  route.hook('onSend', onSend)
}

// The server closes only the stream it sends. A stream the cache answers in place of would keep the file, socket
// or upstream connection behind it open until it is collected. A source that fails to cancel is no reason to fail
// the response.
function discard(payload: SendPayload): void {
  if (payload instanceof ReadableStream) {
    payload.cancel().catch(() => undefined)
  }
}
