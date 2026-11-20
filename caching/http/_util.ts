import { createHash } from 'node:crypto'

import {
  ErrConfiguration,
  appendVary,
  kRouteConstraints,
  type IContext,
  type IRequest,
  type ResolvedRouteConstraint,
  type RouteDefinition,
} from '@caffeinejs/http'
import { type Duration, formatDuration, Second } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { CacheControlOptions, ETagGenerator } from './cache_control.js'

// A route definition's methods as one label, `GET|POST`.
export function routeMethods(route: RouteDefinition): string {
  return route.methods.join('|')
}

// Canonicalizes a request URL so query parameters in a different order share one cache entry
// (`?a=1&b=2` and `?b=2&a=1` are equivalent). Keeps only the parameters in `varyByQuery` when there is a list,
// sorts the rest by key, and leaves a query-less URL untouched.
export function canonicalizeURL(url: string, varyByQuery?: ReadonlySet<string>): string {
  const queryStart = url.indexOf('?')
  if (queryStart === -1) {
    return url
  }

  const path = url.slice(0, queryStart)
  const params = new URLSearchParams(url.slice(queryStart + 1))
  if (varyByQuery !== undefined) {
    for (const name of [...params.keys()]) {
      if (!varyByQuery.has(name)) {
        params.delete(name)
      }
    }
  }
  params.sort()

  const query = params.toString()

  return query ? `${path}?${query}` : path
}

// The one derivation of a store key.
//
// GET and HEAD have equivalent representations — they share the same cache entry. Other methods include the
// method in the key to avoid cross-method collisions. When vary headers are configured, their request values are
// appended to the key so that different header combinations produce separate cache entries (RFC 9111 §4.1).
export function buildCacheKey(
  method: string,
  url: string,
  vary: readonly string[] | undefined,
  headerOf: (name: string) => string | string[] | undefined,
  varyByQuery?: ReadonlySet<string>,
): string {
  const canonical = canonicalizeURL(url, varyByQuery)
  const base = method === 'GET' || method === 'HEAD' ? canonical : `${method}:${canonical}`
  if (!vary?.length) {
    return encodeURIComponent(base)
  }

  const parts = vary.map(h => `${h.toLowerCase()}=${headerOf(h.toLowerCase()) ?? ''}`)

  return encodeURIComponent(`${base}#${parts.join('&')}`)
}

export function defaultCacheKey(
  req: Pick<IRequest, 'method' | 'url' | 'basePath' | 'header'>,
  vary?: readonly string[],
  varyByQuery?: ReadonlySet<string>,
): string {
  // Keyed by the URL as the browser asked for it, base path included: a page answering `/api/x` may link under
  // `/api`, and must not be replayed to `/x`. Without a base path the key is the URL alone, as it always was.
  return buildCacheKey(req.method, req.basePath + req.url, vary, name => req.header(name), varyByQuery)
}

/** The request directives the cache acts on. */
export interface RequestCacheControl {
  readonly noCache: boolean
  readonly noStore: boolean
  readonly onlyIfCached: boolean
  /** Seconds. Absent when the directive is, or when its value is not a number. */
  readonly maxAge: number | undefined
  /** Seconds the entry must stay fresh for (RFC 9111 §5.2.1.3). Absent as `maxAge` is. */
  readonly minFresh: number | undefined
  /** Seconds past its freshness the client accepts (RFC 9111 §5.2.1.2); `Infinity` for the bare directive. */
  readonly maxStale: number | undefined
}

const NO_DIRECTIVES: RequestCacheControl = Object.freeze({
  noCache: false,
  noStore: false,
  onlyIfCached: false,
  maxAge: undefined,
  minFresh: undefined,
  maxStale: undefined,
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
  let minFresh: number | undefined
  let maxStale: number | undefined

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
      maxAge = seconds(part.slice(eq + 1)) ?? maxAge
    } else if (name === 'min-fresh' && eq !== -1) {
      minFresh = seconds(part.slice(eq + 1)) ?? minFresh
    } else if (name === 'max-stale') {
      maxStale = eq === -1 ? Infinity : (seconds(part.slice(eq + 1)) ?? maxStale)
    }
  }

  return { noCache, noStore, onlyIfCached, maxAge, minFresh, maxStale }
}

function seconds(argument: string): number | undefined {
  const raw = argument.trim().replace(/^"(.*)"$/, '$1')

  return /^\d+$/.test(raw) ? Number(raw) : undefined
}

// RFC 9111 §5.4 — `Pragma: no-cache` stands in for the directive only on a request that sent no Cache-Control.
export function pragmaNoCache(req: Pick<IRequest, 'header'>): boolean {
  const pragma = req.header('pragma')
  if (pragma === undefined || req.header('cache-control') !== undefined) {
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
  req: Pick<IRequest, 'header'>,
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  const ifNoneMatch = req.header('if-none-match')
  if (ifNoneMatch) {
    return etag !== undefined && matchesETag(ifNoneMatch, etag)
  }

  const ifModifiedSince = req.header('if-modified-since')
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
  'proxy-authentication-info',
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
export function storedHeadersOf(
  ctx: Pick<IContext, 'getHeaders'>,
  statusHeader: string,
): Record<string, string | string[]> {
  // A copy of the response's own: what is not stored is taken off it.
  const stored = ctx.getHeaders()
  const connection = connectionFieldsOf(stored.connection)

  for (const name in stored) {
    if (name === statusHeader || NOT_STORED.has(name) || name.startsWith('access-control-') || connection?.has(name)) {
      delete stored[name]
    }
  }

  return stored
}

// RFC 9111 §3.1 — the fields a response's `Connection` names are that connection's, whatever they are called.
function connectionFieldsOf(connection: string | string[] | undefined): Set<string> | undefined {
  if (connection === undefined) {
    return undefined
  }

  return new Set(
    [connection]
      .flat()
      .flatMap(value => value.split(','))
      .map(name => name.trim().toLowerCase()),
  )
}

/**
 * How a stored entry's headers land on a reply. On a `hit` a header an earlier hook already set belongs to this
 * request — CORS, authentication — and outranks the stored one; a `revalidation` carries only what guides a cache
 * update (RFC 9110 §15.4.5); a `replacement` writes the entry over an error response the handler produced, so the
 * stored headers win. `Vary` accumulates in every mode.
 */
export type StoredHeadersMode = 'hit' | 'revalidation' | 'replacement'

export function applyStoredHeaders(
  ctx: Pick<IContext, 'hasHeader' | 'header' | 'getHeader'>,
  headers: Record<string, string | string[]>,
  mode: StoredHeadersMode,
): void {
  if (mode === 'revalidation') {
    for (const name of REVALIDATION_HEADERS) {
      const value = headers[name]
      if (value !== undefined && !ctx.hasHeader(name)) {
        writeHeader(ctx, name, value)
      }
    }
  } else {
    const overwrite = mode === 'replacement'
    for (const name in headers) {
      if (name !== 'vary' && (overwrite || !ctx.hasHeader(name))) {
        writeHeader(ctx, name, headers[name])
      }
    }
  }

  const vary = headers.vary
  if (vary !== undefined) {
    appendVary(
      ctx,
      (typeof vary === 'string' ? vary : vary.join(','))
        .split(',')
        .map(name => name.trim())
        .filter(Boolean),
    )
  }
}

// A list goes out as one field line per value, as it was stored.
function writeHeader(ctx: Pick<IContext, 'header'>, name: string, value: string | string[]): void {
  if (typeof value === 'string') {
    ctx.header(name, value)
    return
  }

  ctx.header(name, value[0])
  for (let i = 1; i < value.length; i++) {
    ctx.header(name, value[i], { append: true })
  }
}

export async function generateETag(payload: string | Uint8Array, generator?: ETagGenerator): Promise<string> {
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
    directives.push(`max-age=${Math.floor(opts.ttl / Second)}`)
  }

  if (opts.sharedMaxAge !== undefined) {
    directives.push(`s-maxage=${Math.floor(opts.sharedMaxAge / Second)}`)
  }

  // RFC 9111 §4.2.4 — a response that must be revalidated is never served stale, so the windows are not
  // announced either: what the server-side store does not honour, a cache downstream is not told to.
  const staleAllowed = !opts.mustRevalidate && !opts.proxyRevalidate && !opts.noCache

  if (staleAllowed && opts.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${Math.floor(opts.staleWhileRevalidate / Second)}`)
  }

  if (staleAllowed && opts.staleIfError !== undefined) {
    directives.push(`stale-if-error=${Math.floor(opts.staleIfError / Second)}`)
  }

  return directives.length > 0 ? directives.join(', ') : null
}

// A store reads a ttl of 0 as it pleases — `lru-cache` as "never expires" — so a duration is refused while the
// route registers, not discovered in production. A `ttl` below one second is refused too: `max-age` is whole
// seconds, and it would be sent as `max-age=0`.
export function durationSeconds(route: RouteDefinition, option: string, value: Duration, minimum: 0 | 1): number {
  const seconds = value / Second

  if (!Number.isFinite(seconds) || seconds < minimum) {
    throw new ErrConfiguration(
      errMessage(
        `Cannot install caching on "${routeMethods(route)} ${route.url}": ${option} must be ${
          minimum === 1 ? 'at least one second' : 'a non-negative duration'
        }, such as ${minimum === 1 ? '5 * Minute' : '0'}, got "${formatDuration(value)}"`,
      )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return seconds
}

// A tag names a counter in the store, and a brace in a key would decide its slot on a Redis cluster.
export function assertTags(
  route: RouteDefinition,
  tags: unknown,
  { what, required }: { what: 'caching' | 'cache invalidation'; required: boolean },
): void {
  const where = `Cannot install ${what} on "${routeMethods(route)} ${route.url}"`

  if (tags === undefined) {
    if (required) {
      throw new ErrConfiguration(
        errMessage(`${where}: tags must name at least one tag`).reference('@caffeinejs/http', ErrConfiguration).build(),
      )
    }

    return
  }

  if (!Array.isArray(tags) || (required && tags.length === 0)) {
    throw new ErrConfiguration(
      errMessage(`${where}: tags must name at least one tag`).reference('@caffeinejs/http', ErrConfiguration).build(),
    )
  }

  for (const tag of tags) {
    if (typeof tag !== 'string' || tag === '' || tag.includes('{') || tag.includes('}')) {
      throw new ErrConfiguration(
        errMessage(`${where}: a tag must be a non-empty string without "{" or "}", got "${String(tag)}"`)
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }
}

// Routes that share a URL under different constraints share a default key too, so one would be served the
// other's response. What tells them apart on the wire is the header the constraint reads, which the key carries
// once the route varies on it; a key function of the route's own does the same job.
export function assertConstraintsKeyed(route: RouteDefinition, opts: CacheControlOptions): void {
  if (opts.ttl === undefined || opts.key !== undefined || opts.vary?.includes('*')) {
    return
  }

  const declared = route.config.get(kRouteConstraints) as Map<string, ResolvedRouteConstraint> | undefined
  const headers = new Map<string, string | undefined>()

  for (const [name, constraint] of declared ?? []) {
    headers.set(name, constraint.header)
  }

  const vary = new Set(opts.vary?.map(h => h.toLowerCase()))

  for (const [name, header] of headers) {
    if (header === undefined) {
      throw new ErrConfiguration(
        errMessage(
          `Cannot install caching on "${routeMethods(route)} ${route.url}": constraint "${name}" reads no header the cache key can vary on: give the route a "key" function`,
        )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    if (!vary.has(header.toLowerCase())) {
      throw new ErrConfiguration(
        errMessage(
          `Cannot install caching on "${routeMethods(route)} ${route.url}": the route is constrained on "${header}" and its cache key does not tell it from the other routes on that URL: add "${header}" to "vary", or give the route a "key" function`,
        )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }
}
