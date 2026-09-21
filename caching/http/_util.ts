import { createHash } from 'node:crypto'

import {
  ErrConfiguration,
  appendVary,
  kRouteConstraints,
  kVersionHeader,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
  type ResolvedRouteConstraint,
} from '@caffeinejs/http'
import { DURATION_PATTERN, parseDuration, type Duration } from '@caffeinejs/std'

import { CacheControlOptions, ETagGenerator } from './cache.js'

// A route definition's methods as one label, `GET|POST`. `onRoute` hands over an array for a framework route and
// a string for Fastify's own HEAD twin.
export function routeMethods(routeDef: AdapterRouteOptions): string {
  return [routeDef.method].flat().join('|')
}

// Canonicalizes a request URL so query parameters in a different order share one cache entry
// (`?a=1&b=2` and `?b=2&a=1` are equivalent). Sorts the query keys; leaves query-less URLs untouched.
export function canonicalizeUrl(url: string): string {
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

// The one derivation of a store key, over plain values so the hooks, a path and the `cacheKey` helper all go
// through it.
//
// GET and HEAD have equivalent representations — they share the same cache entry. Other methods include the
// method in the key to avoid cross-method collisions. When vary headers are configured, their request values are
// appended to the key so that different header combinations produce separate cache entries (RFC 9111 §4.1).
export function buildCacheKey(
  method: string,
  url: string,
  vary: readonly string[] | undefined,
  headerOf: (name: string) => string | string[] | undefined,
): string {
  const canonical = canonicalizeUrl(url)
  const base = method === 'GET' || method === 'HEAD' ? canonical : `${method}:${canonical}`
  if (!vary?.length) {
    return encodeURIComponent(base)
  }

  const parts = vary.map(h => `${h.toLowerCase()}=${headerOf(h.toLowerCase()) ?? ''}`)

  return encodeURIComponent(`${base}#${parts.join('&')}`)
}

export function defaultCacheKey(request: AdapterRequest, vary?: readonly string[]): string {
  return buildCacheKey(request.method, request.url, vary, name => request.headers[name])
}

// The key `defaultCacheKey` gives a GET for `path` on a route with no vary — what an invalidation by path must
// delete. Kept beside `defaultCacheKey` so the two derivations cannot drift apart; the property test pins them.
export function pathCacheKey(path: string): string {
  return buildCacheKey('GET', path, undefined, noHeader)
}

function noHeader(): undefined {
  return undefined
}

/** The request directives the cache acts on. */
export interface RequestCacheControl {
  readonly noCache: boolean
  readonly noStore: boolean
  readonly onlyIfCached: boolean
  /** Seconds. Absent when the directive is, or when its value is not a number. */
  readonly maxAge: number | undefined
}

const NO_DIRECTIVES: RequestCacheControl = Object.freeze({
  noCache: false,
  noStore: false,
  onlyIfCached: false,
  maxAge: undefined,
})

// RFC 9111 §5.2 — directive names compare case-insensitively, and an argument may arrive as a token or as a
// quoted string. Matched by whole name, never by substring: `x-no-cache-hint` is not `no-cache`.
export function parseRequestCacheControl(header: string | undefined): RequestCacheControl {
  if (header === undefined || header === '') {
    return NO_DIRECTIVES
  }

  let noCache = false
  let noStore = false
  let onlyIfCached = false
  let maxAge: number | undefined

  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase()

    if (name === 'no-cache') {
      noCache = true
    } else if (name === 'no-store') {
      noStore = true
    } else if (name === 'only-if-cached') {
      onlyIfCached = true
    } else if (name === 'max-age' && eq !== -1) {
      const raw = part
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
      if (/^\d+$/.test(raw)) {
        maxAge = Number(raw)
      }
    }
  }

  return { noCache, noStore, onlyIfCached, maxAge }
}

// RFC 9111 §5.4 — `Pragma: no-cache` stands in for the directive only on a request that sent no Cache-Control.
export function pragmaNoCache(request: AdapterRequest): boolean {
  const pragma = request.headers.pragma
  if (pragma === undefined || request.headers['cache-control'] !== undefined) {
    return false
  }

  return pragma.split(',').some(token => token.trim().toLowerCase() === 'no-cache')
}

const ENTITY_TAG = /(?:W\/)?"[^"]*"/g

// RFC 9110 §13.1.2 — weak comparison: the W/ prefix is ignored. Entity-tags are scanned rather than split on
// commas, which an entity-tag may itself contain.
export function matchesETag(ifNoneMatch: string, storedETag: string): boolean {
  if (ifNoneMatch.trim() === '*') {
    return true
  }

  const normalize = (e: string) => (e.startsWith('W/') ? e.slice(2) : e)
  const stored = normalize(storedETag)

  for (const tag of ifNoneMatch.match(ENTITY_TAG) ?? []) {
    if (normalize(tag) === stored) {
      return true
    }
  }

  return false
}

// RFC 9110 §13.2.2 — If-None-Match, when present, decides alone; If-Modified-Since is read only without it,
// and only when it is a valid date.
export function isNotModified(
  request: AdapterRequest,
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  const ifNoneMatch = request.headers['if-none-match']
  if (ifNoneMatch) {
    return etag !== undefined && matchesETag(ifNoneMatch, etag)
  }

  const ifModifiedSince = request.headers['if-modified-since']
  if (!ifModifiedSince || lastModified === undefined) {
    return false
  }

  return Date.parse(lastModified) <= Date.parse(ifModifiedSince)
}

// What an origin may still send on a 304 (RFC 9110 §15.4.5): the fields that guide a cache update, and no other
// representation metadata.
const REVALIDATION_HEADERS = ['cache-control', 'content-location', 'etag', 'expires', 'last-modified']

// Connection-specific fields (RFC 9111 §3.1), what the server recomputes for every response, and what belongs to
// one exchange rather than to the representation.
const NOT_STORED = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'content-length',
  'date',
  'age',
])

// `statusHeader` is lower-cased by the caller, once per route.
export function storedHeadersOf(reply: AdapterReply, statusHeader: string): Record<string, string | string[]> {
  const all = reply.getHeaders()
  const stored: Record<string, string | string[]> = {}

  for (const name in all) {
    const value = all[name]
    if (value === undefined || name === statusHeader || NOT_STORED.has(name) || name.startsWith('access-control-')) {
      continue
    }

    stored[name] = typeof value === 'number' ? String(value) : value
  }

  return stored
}

// A header an earlier hook already set belongs to this request — CORS, authentication — and outranks the one
// stored with another request's response. `Vary` is the exception: it accumulates.
export function applyStoredHeaders(
  reply: AdapterReply,
  headers: Record<string, string | string[]>,
  revalidation: boolean,
): void {
  if (revalidation) {
    for (const name of REVALIDATION_HEADERS) {
      const value = headers[name]
      if (value !== undefined && !reply.hasHeader(name)) {
        reply.header(name, value)
      }
    }
  } else {
    for (const name in headers) {
      if (name !== 'vary' && !reply.hasHeader(name)) {
        reply.header(name, headers[name])
      }
    }
  }

  const vary = headers.vary
  if (vary !== undefined) {
    appendVary(
      reply,
      (typeof vary === 'string' ? vary : vary.join(','))
        .split(',')
        .map(name => name.trim())
        .filter(Boolean),
    )
  }
}

export async function generateETag(payload: string | Buffer, generator?: ETagGenerator): Promise<string> {
  const buf = typeof payload === 'string' ? Buffer.from(payload) : payload

  if (generator) {
    return generator(buf)
  }

  return `"${createHash('sha1').update(buf).digest('hex').slice(0, 16)}"`
}

export function buildCacheControl(opts: CacheControlOptions, privacyOverride?: 'private' | 'public'): string | null {
  if (opts.noStore) {
    return 'no-store'
  }

  const directives: string[] = []

  if (opts.noCache) {
    directives.push('no-cache')
  }

  const privacy = privacyOverride ?? opts.privacy
  const hasMaxAge = opts.ttl !== undefined || opts.sharedMaxAge !== undefined
  if (privacy === 'private') {
    directives.push('private')
  } else if (privacy === 'public' || hasMaxAge) {
    directives.push('public')
  }

  if (opts.immutable) {
    directives.push('immutable')
  }

  if (opts.noTransform) {
    directives.push('no-transform')
  }

  if (opts.mustRevalidate) {
    directives.push('must-revalidate')
  }

  if (opts.proxyRevalidate) {
    directives.push('proxy-revalidate')
  }

  if (opts.ttl !== undefined) {
    directives.push(`max-age=${Math.round(parseDuration(opts.ttl))}`)
  }

  if (opts.sharedMaxAge !== undefined) {
    directives.push(`s-maxage=${Math.round(parseDuration(opts.sharedMaxAge))}`)
  }

  if (opts.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${Math.round(parseDuration(opts.staleWhileRevalidate))}`)
  }

  if (opts.staleIfError !== undefined) {
    directives.push(`stale-if-error=${Math.round(parseDuration(opts.staleIfError))}`)
  }

  return directives.length > 0 ? directives.join(', ') : null
}

const DURATION = new RegExp(DURATION_PATTERN)

// `parseDuration` reads what it cannot parse as 0, and a store reads a ttl of 0 as it pleases — `lru-cache` as
// "never expires". So a duration is refused while the route registers, not discovered in production.
export function durationSeconds(
  routeDef: AdapterRouteOptions,
  option: string,
  value: Duration,
  positive: boolean,
): number {
  const seconds = typeof value === 'string' && !DURATION.test(value) ? Number.NaN : parseDuration(value)

  if (!Number.isFinite(seconds) || seconds < 0 || (positive && seconds === 0)) {
    throw new ErrConfiguration(
      `Cannot install caching on "${routeMethods(routeDef)} ${routeDef.url}": ${option} must be a ${
        positive ? 'positive' : 'non-negative'
      } duration such as 60 or "5m", got "${String(value)}"`,
    )
  }

  return seconds
}

// Routes that share a URL under different constraints share a default key too, so one would be served the
// other's response. What tells them apart on the wire is the header the constraint reads, which the key carries
// once the route varies on it; a segment of its own, or its own key function, does the same job.
export function assertConstraintsKeyed(routeDef: AdapterRouteOptions, opts: CacheControlOptions): void {
  if (opts.ttl === undefined || opts.key !== undefined || opts.segment || opts.vary?.includes('*')) {
    return
  }

  const declared = (routeDef.config as Record<string, unknown> | undefined)?.[kRouteConstraints] as
    | Map<string, ResolvedRouteConstraint>
    | undefined
  const headers = new Map<string, string | undefined>()

  for (const [name, constraint] of declared ?? []) {
    headers.set(name, constraint.header)
  }

  for (const name of Object.keys((routeDef.constraints as Record<string, unknown> | undefined) ?? {})) {
    if (!headers.has(name)) {
      headers.set(name, name === 'version' ? kVersionHeader : name === 'host' ? 'Host' : undefined)
    }
  }

  const vary = new Set(opts.vary?.map(h => h.toLowerCase()))

  for (const [name, header] of headers) {
    if (header === undefined) {
      throw new ErrConfiguration(
        `Cannot install caching on "${routeMethods(routeDef)} ${routeDef.url}": constraint "${name}" reads no header the cache key can vary on: give the route its own "segment" or a "key" function`,
      )
    }

    if (!vary.has(header.toLowerCase())) {
      throw new ErrConfiguration(
        `Cannot install caching on "${routeMethods(routeDef)} ${routeDef.url}": the route is constrained on "${header}" and its cache key does not tell it from the other routes on that URL: add "${header}" to "vary", or give the route its own "segment" or a "key" function`,
      )
    }
  }
}
