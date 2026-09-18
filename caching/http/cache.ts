import {
  FastifyContextRequest,
  addRouteHook,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
} from '@caffeinejs/http'
import { Duration, parseDuration } from '@caffeinejs/std'
import { FastifyRequest } from 'fastify'

import './_fastify.js'
import type { Cache } from '../store.js'
import { cacheRouteOf } from './_observe.js'
import { buildCacheControl, defaultCacheKey, generateETag, matchesETag } from './_util.js'
import type { CacheBypassReason, CacheObserver } from './observer.js'

const DEFAULT_METHODS = ['GET', 'HEAD']
const DEFAULT_STATUS_CODES = [200]

// Cache-status values reported via the status header (default `X-Cache`).
const CACHE_HIT = 'HIT'
const CACHE_MISS = 'MISS'
const CACHE_BYPASS = 'BYPASS'

export type ETagGenerator = (payload: Buffer) => string | Promise<string>

export interface CacheControlOptions {
  ttl?: Duration
  sharedMaxAge?: Duration
  staleWhileRevalidate?: Duration
  staleIfError?: Duration
  noStore?: boolean
  noCache?: boolean
  mustRevalidate?: boolean
  proxyRevalidate?: boolean
  noTransform?: boolean
  privacy?: 'private' | 'public'
  immutable?: boolean
  vary?: string[]
  etag?: boolean
  methods?: string[]
  statusCodes?: number[]
  segment?: string
  key?: (req: FastifyContextRequest) => string
  etagGenerator?: ETagGenerator
}

/** What the cache hooks need, resolved once at start-up by `HTTPCaching`. */
export interface CacheDeps {
  store: Cache
  etagGenerator: ETagGenerator | undefined
  statusHeader: string
  /**
   * Called as given. `HTTPCaching` hands over one wrapped so a throw never reaches the response; a caller building
   * these itself for `cachePlugin` or `attachCacheHooks` owns that.
   */
  observer?: CacheObserver
}

/**
 * Attaches the read and store hooks to one route, per its `@CacheControl` options.
 *
 * Serves cacheable responses from and stores them into the container-resolved {@link Cache}, and emits
 * `Cache-Control`/`ETag`/`Vary` headers.
 *
 * `opts` is closed over rather than re-read from `request.routeOptions.config` per request: the hooks are
 * attached only to routes that declared options, so what they would read back is already known here.
 *
 * `@CacheControl(false)` gets the store hook alone — it has nothing to serve, but it still has to emit the
 * no-cache headers.
 */
export function attachCacheHooks(
  routeDef: AdapterRouteOptions,
  opts: CacheControlOptions | false,
  deps: CacheDeps,
): void {
  const { store, etagGenerator, statusHeader, observer } = deps

  // Resolved here, once per route, and only when someone is listening. Every call site below is
  // `observer?.onX?.({...})`: the optional call short-circuits before its argument is built, so an unobserved
  // route allocates no event.
  const route = observer === undefined ? undefined : cacheRouteOf(routeDef)
  const ttlSeconds = observer !== undefined && opts !== false && opts.ttl !== undefined ? parseDuration(opts.ttl) : 0

  if (opts !== false) {
    // A separate binding so the closure below sees `CacheControlOptions`, not the union: TypeScript does not
    // carry a parameter's narrowing into a nested function.
    const read: CacheControlOptions = opts

    // OnRequest phase: check if the request is cacheable and return the cached response if it is
    async function onRequest(request: AdapterRequest, reply: AdapterReply) {
      const methods = read.methods ?? DEFAULT_METHODS
      if (!methods.includes(request.method)) {
        // No status header here, but the observer still hears of it: leaving it out would drop these requests from
        // every hit ratio computed off the events.
        observer?.onBypass?.({ route: route!, segment: read.segment, reason: 'method' })
        return
      }

      // RFC 7234 §3.2 — Authorization present without explicit public override → never serve from cache
      const hasAuth = !!request.headers.authorization
      const effectivePrivacy = read.privacy ?? (hasAuth ? 'private' : undefined)
      if (effectivePrivacy === 'private') {
        reply.header(statusHeader, CACHE_BYPASS)
        observer?.onBypass?.({
          route: route!,
          segment: read.segment,
          reason: read.privacy === 'private' ? 'private' : 'authorization',
        })
        return
      }

      // RFC 7234 §4.1 — Vary: * always fails to match; never serve from cache
      if (read.vary?.includes('*')) {
        reply.header(statusHeader, CACHE_BYPASS)
        observer?.onBypass?.({ route: route!, segment: read.segment, reason: 'vary-any' })
        return
      }

      // RFC 7234 §5.2.1.4 — bypass cache when client requests fresh response
      const reqCC = request.headers['cache-control']
      const reqMaxAge0 = reqCC != null && /(?:^|,)\s*max-age\s*=\s*0(?:\s*,|$)/.test(reqCC)
      if (
        reqCC?.includes('no-cache') ||
        reqCC?.includes('no-store') ||
        reqMaxAge0 ||
        request.headers['pragma'] === 'no-cache'
      ) {
        reply.header(statusHeader, CACHE_BYPASS)
        observer?.onBypass?.({ route: route!, segment: read.segment, reason: clientBypassReason(reqCC, reqMaxAge0) })
        return
      }

      // Vary-aware cache key — must match key used in onSend
      const key = read.key
        ? read.key(new FastifyContextRequest(request as FastifyRequest))
        : defaultCacheKey(request, read.vary)
      const cached = await store.get(key, read.segment)
      if (!cached) {
        if (reqCC?.includes('only-if-cached')) {
          observer?.onMiss?.({ route: route!, segment: read.segment, key, reason: 'only-if-cached' })
          return reply.code(504).send()
        }
        reply.header(statusHeader, CACHE_MISS)
        observer?.onMiss?.({ route: route!, segment: read.segment, key, reason: 'absent' })
        return
      }

      // RFC 9111 §4.2.3 — apparent age of the stored response, in whole seconds.
      const age = cached.storedAt ? Math.max(0, Math.floor((Date.now() - cached.storedAt) / 1000)) : 0

      // RFC 9111 §5.2.1.1 — a client's max-age caps how stale a response it will accept from the cache.
      const reqMaxAge = requestMaxAge(reqCC)
      if (reqMaxAge !== undefined && age > reqMaxAge) {
        reply.header(statusHeader, CACHE_MISS)
        observer?.onMiss?.({ route: route!, segment: read.segment, key, reason: 'stale-for-request' })
        return
      }

      // RFC 7232 §6 — If-None-Match takes precedence over If-Modified-Since
      const ifNoneMatch = request.headers['if-none-match']
      if (ifNoneMatch) {
        if (cached.etag && matchesETag(ifNoneMatch, cached.etag)) {
          request.responseCached = true
          observer?.onHit?.({ route: route!, segment: read.segment, key, revalidated: true, ageSeconds: age })
          return reply
            .code(304)
            .headers(cached.headers)
            .header(statusHeader, CACHE_HIT)
            .header('Age', String(age))
            .send()
        }
      } else {
        const ifModifiedSince = request.headers['if-modified-since']
        if (ifModifiedSince && cached.lastModified) {
          if (Date.parse(cached.lastModified) <= Date.parse(ifModifiedSince)) {
            request.responseCached = true
            observer?.onHit?.({ route: route!, segment: read.segment, key, revalidated: true, ageSeconds: age })
            return reply
              .code(304)
              .headers(cached.headers)
              .header(statusHeader, CACHE_HIT)
              .header('Age', String(age))
              .send()
          }
        }
      }

      // RFC 7230 §3.3 — HEAD responses must not include a body
      request.responseCached = true
      reply.status(200).headers(cached.headers).header(statusHeader, CACHE_HIT).header('Age', String(age))
      observer?.onHit?.({ route: route!, segment: read.segment, key, revalidated: false, ageSeconds: age })
      if (request.method === 'HEAD') {
        return reply.send()
      }

      return reply.send(cached.payload)
    }

    addRouteHook(routeDef, 'onRequest', onRequest)
  }

  // Before sending the response,
  // we need to build the cache control headers and store the response in the cache
  async function onSend(request: AdapterRequest, reply: AdapterReply, payload: unknown) {
    if (request.responseCached) {
      return payload
    }

    // @CacheControl(false): actively disable caching with the full set of no-cache headers
    if (opts === false) {
      reply.header('Cache-Control', 'no-store, max-age=0, must-revalidate, proxy-revalidate')
      reply.header('Expires', '0')
      reply.header('Pragma', 'no-cache')
      reply.header('Surrogate-Control', 'no-store')
      reply.header(statusHeader, CACHE_BYPASS)
      observer?.onBypass?.({ route: route!, reason: 'disabled' })
      return payload
    }

    const methods = opts.methods ?? DEFAULT_METHODS
    const statusCodes = opts.statusCodes ?? DEFAULT_STATUS_CODES
    const isCacheableMethod = methods.includes(request.method)
    const isCacheableStatus = statusCodes.includes(reply.statusCode)

    const hasAuth = !!request.headers.authorization
    const effectivePrivacy = opts.privacy ?? (hasAuth ? 'private' : undefined)

    const cacheControl = buildCacheControl(opts, effectivePrivacy)
    if (cacheControl) {
      reply.header('Cache-Control', cacheControl)
    }

    if (opts.vary?.length) {
      reply.header('Vary', opts.vary.join(', '))
    }

    const isStringOrBuffer = typeof payload === 'string' || Buffer.isBuffer(payload)
    const shouldETag = opts.etag !== false && isCacheableStatus && !opts.noStore && isStringOrBuffer

    let etag: string | undefined
    if (shouldETag) {
      etag = await generateETag(payload as string | Buffer, opts.etagGenerator ?? etagGenerator)
      reply.header('ETag', etag)
    }

    // ETag and storage are independent — etag: false must not prevent caching
    // Private responses must not be stored in the shared server-side cache
    // RFC 7234 §4.1 — Vary: * means the response must never be cached
    const shouldCache =
      opts.ttl !== undefined &&
      !opts.noStore &&
      effectivePrivacy !== 'private' &&
      !opts.vary?.includes('*') &&
      isCacheableMethod &&
      isCacheableStatus &&
      isStringOrBuffer

    if (shouldCache) {
      const headers: Record<string, string> = {}
      const contentType = reply.getHeader('content-type')

      if (typeof contentType === 'string') {
        headers['content-type'] = contentType
      }

      if (cacheControl) {
        headers['cache-control'] = cacheControl
      }

      if (etag) {
        headers['etag'] = etag
      }

      if (opts.vary?.length) {
        headers['vary'] = opts.vary.join(', ')
      }

      const lastModified = new Date().toUTCString()
      headers['last-modified'] = lastModified
      reply.header('Last-Modified', lastModified)

      // Vary-aware cache key — must match key used in onRequest
      const key = opts.key
        ? opts.key(new FastifyContextRequest(request as FastifyRequest))
        : defaultCacheKey(request, opts.vary)

      await store.set(
        key,
        {
          payload: payload as string | Buffer,
          etag,
          lastModified,
          storedAt: Date.now(),
          headers,
        },
        opts.ttl!,
        opts.segment,
      )

      // After the write settles: a `set` that rejected stored nothing.
      observer?.onStore?.({
        route: route!,
        segment: opts.segment,
        key,
        bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : (payload as Buffer).length,
        ttlSeconds,
      })
    }

    return payload
  }

  addRouteHook(routeDef, 'onSend', onSend)
}

// Parses the numeric `max-age=N` from a request Cache-Control header. Returns undefined when absent.
function requestMaxAge(cacheControl: string | undefined): number | undefined {
  if (cacheControl == null) {
    return undefined
  }
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(cacheControl)

  return match ? Number(match[1]) : undefined
}

// Which client directive bypassed the cache, tested in the order the read hook tests them.
function clientBypassReason(cacheControl: string | undefined, maxAge0: boolean): CacheBypassReason {
  if (cacheControl?.includes('no-cache')) {
    return 'no-cache'
  }

  if (cacheControl?.includes('no-store')) {
    return 'no-store'
  }

  return maxAge0 ? 'max-age-0' : 'pragma-no-cache'
}
