import { ErrHTTPBadRequest } from '../error/http.js'
import { literalPrefix, routePathSegments, underPrefix } from '../routing/paths.js'
import type { MiddlewarePath } from './middleware.js'
import type { ResolvedMiddleware } from './pipeline.js'

// Path matching for middleware registered under a path. It normalizes the URL the way the router does, so a path-scoped
// middleware cannot be skipped by a request the router still sends to the guarded route.

// Encoded characters where decodeURIComponent(x) !== decodeURI(x): % # $ & + , / : ; = ? @
const RESERVED_ENCODINGS = new Set(['25', '23', '24', '26', '2B', '2C', '2F', '3A', '3B', '3D', '3F', '40'])

/**
 * What a middleware's path matches: each of its literal prefixes, on whole segments and case-sensitively, as the router
 * matches a route.
 */
export function prefixMatcher(path: MiddlewarePath): (path: string) => boolean {
  const prefixes = (typeof path === 'string' ? [path] : path).map(literalPrefix)
  return request => prefixes.some(prefix => underPrefix(request, prefix))
}

/** The path of `url`, before its `?` or `#`. */
export function sanitizeURL(url: string): string {
  for (let i = 0; i < url.length; i++) {
    const charCode = url.charCodeAt(i)
    if (charCode === 63 || charCode === 35) {
      return url.slice(0, i)
    }
  }
  return url
}

/**
 * The path of `url` as the router matches it, or the `ErrHTTPBadRequest` a malformed one fails with. `url` is a path
 * without its query: see {@link sanitizeURL}.
 */
export function normalizePath(url: string): { path: string; error: Error | undefined } {
  let path = url

  if (path.charCodeAt(0) !== 47) {
    const absolute = pathFromAbsoluteURL(path)
    if (absolute === null) {
      return { path: url, error: malformedURL() }
    }
    path = absolute
  }

  try {
    path = safeDecodeURI(path)
  } catch {
    return { path: url, error: malformedURL() }
  }

  // The router keeps encoded slashes, but a literal `%` can still introduce one more encoded byte.
  path = path.replace(/%25([0-9A-Fa-f]{2})/g, '%$1')

  return { path, error: undefined }
}

/** A middleware as a level of the engine runs it. */
export interface PlacedMiddleware extends ResolvedMiddleware {
  /**
   * How many leading segments of the request path `path` is relative to: those of the router's or controller's path a
   * relative path was added under. `undefined` for a path from the start of the request path.
   */
  readonly skip?: number
}

/**
 * A router's or a controller's middleware with each relative path placed under `base`, that scope's path: `/jobs`
 * added by a router at `/admin` matches `/admin/jobs`. A middleware with no path covers every route of the scope
 * already, and keeps none.
 *
 * It runs only for the scope's routes, whose paths the router matched from `base`: the path is matched after as many
 * segments as `base` spans, whatever its parameters hold.
 */
export function placeMiddlewares(base: string, middlewares: readonly ResolvedMiddleware[]): PlacedMiddleware[] {
  if (!middlewares.some(middleware => middleware.path !== undefined)) {
    return [...middlewares]
  }

  const skip = routePathSegments(base)

  return middlewares.map(middleware => (middleware.path === undefined ? middleware : { ...middleware, skip }))
}

/**
 * The part of a normalized request path after its first `skip` segments: `''` when it has no more. What a middleware
 * added under a scope matches.
 */
export function pathAfter(path: string, skip: number): string {
  let at = 0
  for (let segment = 0; segment < skip; segment++) {
    at = path.indexOf('/', at + 1)
    if (at === -1) {
      return ''
    }
  }
  return skip === 0 ? path : path.slice(at)
}

function pathFromAbsoluteURL(url: string): string | null {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) {
    return url
  }

  const scheme = url.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    return url
  }

  const authorityStart = schemeEnd + 3
  const pathStart = url.indexOf('/', authorityStart)
  if (pathStart === authorityStart || !URL.canParse(url)) {
    return null
  }

  return pathStart === -1 ? '/' : url.slice(pathStart)
}

// Decodes the path the way find-my-way does: reserved encodings stay encoded, and `%25` is re-encoded so it
// is not decoded twice.
function safeDecodeURI(path: string): string {
  let shouldDecode = false

  for (let i = 1; i < path.length; i++) {
    const charCode = path.charCodeAt(i)

    if (charCode === 37) {
      const hex = path.slice(i + 1, i + 3).toUpperCase()
      if (!RESERVED_ENCODINGS.has(hex)) {
        shouldDecode = true
      } else {
        if (hex === '25') {
          shouldDecode = true
          path = path.slice(0, i + 1) + '25' + path.slice(i + 1)
          i += 2
        }
        i += 2
      }
    } else if (charCode === 63 || charCode === 35) {
      path = path.slice(0, i)
      break
    }
  }

  return shouldDecode ? decodeURI(path) : path
}

function malformedURL(): Error {
  return new ErrHTTPBadRequest('Cannot match the request path: the URL is malformed')
}
