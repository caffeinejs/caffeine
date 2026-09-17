import { parseDuration } from '@caffeinejs/std'

import { CacheControlOptions, ETagGenerator } from './cache.js'

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
