import type { Container } from '@caffeinejs/di'
import { Duration, parseDuration } from '@caffeinejs/std'
import { FastifyRequest } from 'fastify'

import { FastifyContextRequest } from '../context.js'
import {
  addRouteHook,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
} from '../internal/route_hooks.js'
import { buildCacheControl, generateETag, matchesETag } from './_util.js'
import { kCacheStatusHeader, kETagGenerator } from './keys.js'
import { CacheStore } from './store.js'

const DEFAULT_METHODS = ['GET', 'HEAD']
const DEFAULT_STATUS_CODES = [200]
const DEFAULT_STATUS_HEADER = 'X-Cache'

// Cache-status values reported via the status header (default `X-Cache`).
const CACHE_HIT = 'HIT'
const CACHE_MISS = 'MISS'
const CACHE_BYPASS = 'BYPASS'

export type ETagGenerator = (payload: Buffer) => string | Promise<string>

export interface CacheEntry {
  payload: string | Buffer
  etag?: string
  lastModified?: string
  /** Epoch milliseconds when the entry was stored; used to compute the `Age` header and honor request `max-age`. */
  storedAt?: number
  headers: Record<string, string>
}

export interface CacheOptions {
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

/** What the cache hooks need from the container, resolved once at start-up. */
export interface CacheDeps {
  store: CacheStore
  etagGenerator: ETagGenerator | undefined
  statusHeader: string
}

/** Resolves the cache's dependencies. Called once during setup, never per route and never per request. */
export function resolveCacheDeps(container: Container): CacheDeps {
  return {
    store: container.get(CacheStore),
    etagGenerator: container.getOptional<ETagGenerator>(kETagGenerator),
    statusHeader: container.getOptional<string>(kCacheStatusHeader) ?? DEFAULT_STATUS_HEADER,
  }
}

/**
 * Attaches the read and store hooks to one route, per its `@Cache` options.
 *
 * Serves cacheable responses from and stores them into the container-resolved {@link CacheStore}, and emits
 * `Cache-Control`/`ETag`/`Vary` headers.
 *
 * `opts` is closed over rather than re-read from `request.routeOptions.config` per request: the hooks are
 * attached only to routes that declared options, so what they would read back is already known here.
 *
 * `@Cache(false)` gets the store hook alone — it has nothing to serve, but it still has to emit the
 * no-cache headers.
 */
export function attachCacheHooks(routeDef: AdapterRouteOptions, opts: CacheOptions | false, deps: CacheDeps): void {
  const { store, etagGenerator, statusHeader } = deps

  if (opts !== false) {
    // A separate binding so the closure below sees `CacheOptions`, not the union: TypeScript does not
    // carry a parameter's narrowing into a nested function.
    const read: CacheOptions = opts

    // OnRequest phase: check if the request is cacheable and return the cached response if it is
    async function onRequest(request: AdapterRequest, reply: AdapterReply) {
      const methods = read.methods ?? DEFAULT_METHODS
      if (!methods.includes(request.method)) {
        return
      }

      // RFC 7234 §3.2 — Authorization present without explicit public override → never serve from cache
      const hasAuth = !!request.headers.authorization
      const effectivePrivacy = read.privacy ?? (hasAuth ? 'private' : undefined)
      if (effectivePrivacy === 'private') {
        reply.header(statusHeader, CACHE_BYPASS)
        return
      }

      // RFC 7234 §4.1 — Vary: * always fails to match; never serve from cache
      if (read.vary?.includes('*')) {
        reply.header(statusHeader, CACHE_BYPASS)
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
        return
      }

      // Vary-aware cache key — must match key used in onSend
      const key = read.key
        ? read.key(new FastifyContextRequest(request as FastifyRequest))
        : defaultCacheKey(request, read.vary)
      const segment = read.segment ?? ''
      const cached = await store.get(key, segment)
      if (!cached) {
        if (reqCC?.includes('only-if-cached')) {
          return reply.code(504).send()
        }
        reply.header(statusHeader, CACHE_MISS)
        return
      }

      // RFC 9111 §4.2.3 — apparent age of the stored response, in whole seconds.
      const age = cached.storedAt ? Math.max(0, Math.floor((Date.now() - cached.storedAt) / 1000)) : 0

      // RFC 9111 §5.2.1.1 — a client's max-age caps how stale a response it will accept from the cache.
      const reqMaxAge = requestMaxAge(reqCC)
      if (reqMaxAge !== undefined && age > reqMaxAge) {
        reply.header(statusHeader, CACHE_MISS)
        return
      }

      // RFC 7232 §6 — If-None-Match takes precedence over If-Modified-Since
      const ifNoneMatch = request.headers['if-none-match']
      if (ifNoneMatch) {
        if (cached.etag && matchesETag(ifNoneMatch, cached.etag)) {
          request.responseCached = true
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

    // @Cache(false): actively disable caching with the full set of no-cache headers
    if (opts === false) {
      reply.header('Cache-Control', 'no-store, max-age=0, must-revalidate, proxy-revalidate')
      reply.header('Expires', '0')
      reply.header('Pragma', 'no-cache')
      reply.header('Surrogate-Control', 'no-store')
      reply.header(statusHeader, CACHE_BYPASS)
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

      const segment = opts.segment ?? ''

      await store.set(
        key,
        segment,
        {
          payload: payload as string | Buffer,
          etag,
          lastModified,
          storedAt: Date.now(),
          headers,
        },
        parseDuration(opts.ttl!),
      )
    }

    return payload
  }

  addRouteHook(routeDef, 'onSend', onSend)
}

// Canonicalizes a request URL so query parameters in a different order share one cache entry
// (`?a=1&b=2` and `?b=2&a=1` are equivalent). Sorts the query keys; leaves query-less URLs untouched.
function canonicalizeUrl(url: string): string {
  const queryStart = url.indexOf('?')
  if (queryStart === -1) {
    return url
  }

  const path = url.slice(0, queryStart)
  const params = new URLSearchParams(url.slice(queryStart + 1))
  params.sort()

  const query = params.toString()

  return query ? `${path}?${query}` : path
}

// GET and HEAD have equivalent representations — they share the same cache entry.
// Other methods include the method in the key to avoid cross-method collisions.
// When vary headers are configured, their request values are appended to the key
// so that different header combinations produce separate cache entries (RFC 7234 §4.1).
function defaultCacheKey(request: AdapterRequest, vary?: string[]): string {
  const url = canonicalizeUrl(request.url)
  const base = request.method === 'GET' || request.method === 'HEAD' ? url : `${request.method}:${url}`
  if (!vary?.length) {
    return encodeURIComponent(base)
  }

  const parts = vary.map(h => `${h.toLowerCase()}=${request.headers[h.toLowerCase()] ?? ''}`)

  return encodeURIComponent(`${base}#${parts.join('&')}`)
}

// Parses the numeric `max-age=N` from a request Cache-Control header. Returns undefined when absent.
function requestMaxAge(cacheControl: string | undefined): number | undefined {
  if (cacheControl == null) {
    return undefined
  }
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(cacheControl)

  return match ? Number(match[1]) : undefined
}
