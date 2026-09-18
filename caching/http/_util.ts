import type { AdapterRequest, AdapterRouteOptions } from '@caffeinejs/http'
import { parseDuration } from '@caffeinejs/std'

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

// GET and HEAD have equivalent representations — they share the same cache entry.
// Other methods include the method in the key to avoid cross-method collisions.
// When vary headers are configured, their request values are appended to the key
// so that different header combinations produce separate cache entries (RFC 7234 §4.1).
export function defaultCacheKey(request: AdapterRequest, vary?: string[]): string {
  const url = canonicalizeUrl(request.url)
  const base = request.method === 'GET' || request.method === 'HEAD' ? url : `${request.method}:${url}`
  if (!vary?.length) {
    return encodeURIComponent(base)
  }

  const parts = vary.map(h => `${h.toLowerCase()}=${request.headers[h.toLowerCase()] ?? ''}`)

  return encodeURIComponent(`${base}#${parts.join('&')}`)
}

// The key `defaultCacheKey` gives a GET for `path` on a route with no vary — what an invalidation by path must
// delete. Kept beside `defaultCacheKey` so the two derivations cannot drift apart; the property test pins them.
export function pathCacheKey(path: string): string {
  return encodeURIComponent(canonicalizeUrl(path))
}

// RFC 7232 §3.2 — weak comparison: strip W/ prefix, handle comma-separated list and wildcard
export function matchesETag(ifNoneMatch: string, storedETag: string): boolean {
  if (ifNoneMatch === '*') {
    return true
  }

  const normalize = (e: string) => (e.startsWith('W/') ? e.slice(2) : e)
  const stored = normalize(storedETag)

  return ifNoneMatch
    .split(',')
    .map(e => normalize(e.trim()))
    .some(e => e === stored)
}

export async function generateETag(payload: string | Buffer, generator?: ETagGenerator): Promise<string> {
  const buf = typeof payload === 'string' ? Buffer.from(payload) : payload

  if (generator) {
    return generator(buf)
  }

  // Copied into its own ArrayBuffer: a pooled Buffer is ArrayBufferLike, which BufferSource no longer accepts
  const hash = await crypto.subtle.digest('SHA-1', new Uint8Array(buf))
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return `"${hex.slice(0, 16)}"`
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
