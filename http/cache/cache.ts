import { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { parseDuration } from '@caffeinejs/application'
import { FastifyContextRequest } from '../context.js'
import { RouteConfigurer } from '../route_configurer.js'
import { CacheOptions, CacheStore, ETagGenerator } from './types.js'
import { buildCacheControl, generateETag, matchesETag } from './_util.js'

const DEFAULT_METHODS = ['GET', 'HEAD']
const DEFAULT_STATUS_CODES = [200]

export function cacheConfigurer(store: CacheStore, etagGenerator?: ETagGenerator): RouteConfigurer {
  return input => {
    // OnRequest phase: check if the request is cacheable and return the cached response if it is
    async function onRequest(request: FastifyRequest, reply: FastifyReply) {
      const config = request.routeOptions.config as unknown as Record<string, unknown>
      const opts = config.cache as CacheOptions | false

      // No @Cache decorator, or @Cache(false) — nothing to serve from cache
      if (opts === false) {
        return
      }

      const methods = opts.methods ?? DEFAULT_METHODS
      if (!methods.includes(request.method)) {
        return
      }

      // RFC 7234 §3.2 — Authorization present without explicit public override → never serve from cache
      const hasAuth = !!request.headers.authorization
      const effectivePrivacy = opts.privacy ?? (hasAuth ? 'private' : undefined)
      if (effectivePrivacy === 'private') {
        return
      }

      // RFC 7234 §4.1 — Vary: * always fails to match; never serve from cache
      if (opts.vary?.includes('*')) {
        return
      }

      // RFC 7234 §5.2.1.4 — bypass cache when client requests fresh response
      const reqCC = request.headers['cache-control']
      const reqMaxAge0 = reqCC != null && /(?:^|,)\s*max-age\s*=\s*0(?:\s*,|$)/.test(reqCC)
      if (reqCC?.includes('no-cache') || reqCC?.includes('no-store') || reqMaxAge0 || request.headers['pragma'] === 'no-cache') {
        return
      }

      // Vary-aware cache key — must match key used in onSend
      const key = opts.key
        ? opts.key(new FastifyContextRequest(request))
        : defaultCacheKey(request, opts.vary)
      const segment = opts.segment ?? ''
      const cached = await store.get(key, segment)
      if (!cached) {
        if (reqCC?.includes('only-if-cached')) {
          return reply.code(504).send()
        }
        return
      }

      // RFC 7232 §6 — If-None-Match takes precedence over If-Modified-Since
      const ifNoneMatch = request.headers['if-none-match']
      if (ifNoneMatch) {
        if (cached.etag && matchesETag(ifNoneMatch, cached.etag)) {
          request.caffeineResponseCached = true
          return reply.code(304)
            .headers(cached.headers)
            .send()
        }
      } else {
        const ifModifiedSince = request.headers['if-modified-since']
        if (ifModifiedSince && cached.lastModified) {
          if (Date.parse(cached.lastModified) <= Date.parse(ifModifiedSince)) {
            request.caffeineResponseCached = true
            return reply.code(304)
              .headers(cached.headers)
              .send()
          }
        }
      }

      // RFC 7230 §3.3 — HEAD responses must not include a body
      request.caffeineResponseCached = true
      reply.status(200).headers(cached.headers)
      if (request.method === 'HEAD') {
        return reply.send()
      }

      return reply.send(cached.payload)
    }

    // Before sending the response,
    // we need to build the cache control headers and store the response in the cache
    async function onSend(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
      if (request.caffeineResponseCached) {
        return payload
      }

      const config = request.routeOptions.config as unknown as Record<string, unknown>
      const opts = config.cache as CacheOptions | false

      // @Cache(false): actively disable caching with the full set of no-cache headers
      if (opts === false) {
        reply.header('Cache-Control', 'no-store, max-age=0, must-revalidate, proxy-revalidate')
        reply.header('Expires', '0')
        reply.header('Pragma', 'no-cache')
        reply.header('Surrogate-Control', 'no-store')
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
      const shouldCache = opts.ttl !== undefined
        && !opts.noStore
        && effectivePrivacy !== 'private'
        && !opts.vary?.includes('*')
        && isCacheableMethod
        && isCacheableStatus
        && isStringOrBuffer

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
          ? opts.key(new FastifyContextRequest(request))
          : defaultCacheKey(request, opts.vary)

        const segment = opts.segment ?? ''

        await store.set(key, segment, {
          payload: payload as string | Buffer,
          etag,
          lastModified,
          headers,
        }, parseDuration(opts.ttl!))
      }

      return payload
    }

    // If @Cache is not configured or is disabled with @Cache(false),
    // we don't need to add the onRequest hook
    if (input.routeDef.config?.cache) {
      ;(input.routeDef.onRequest as Array<RouteOptions['onRequest']>).push(onRequest)
    }

    // A disabled @Cache(false) route still needs to set the no-cache headers in onSend
    if (input.routeDef.config?.cache !== undefined) {
      ;(input.routeDef.onSend as Array<RouteOptions['onSend']>).push(onSend)
    }
  }
}

// GET and HEAD have equivalent representations — they share the same cache entry.
// Other methods include the method in the key to avoid cross-method collisions.
// When vary headers are configured, their request values are appended to the key
// so that different header combinations produce separate cache entries (RFC 7234 §4.1).
function defaultCacheKey(request: FastifyRequest, vary?: string[]): string {
  const base = request.method === 'GET' || request.method === 'HEAD'
    ? request.url
    : `${request.method}:${request.url}`
  if (!vary?.length) {
    return encodeURIComponent(base)
  }

  const parts = vary.map(h => `${h.toLowerCase()}=${request.headers[h.toLowerCase()] ?? ''}`)

  return encodeURIComponent(`${base}#${parts.join('&')}`)
}
