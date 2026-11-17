import { errMessage } from '@caffeinejs/std/err'
import { pathToRegexp } from 'path-to-regexp'

import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import type { RouterFlags } from '../matcher/matcher.js'
import type { MiddlewarePath } from './middleware.js'
import type { ResolvedMiddleware } from './pipeline.js'

// Path matching for middleware mounted under a path. It normalizes the URL the way the router does, so a path-scoped
// middleware cannot be skipped by a request the router still sends to the guarded route.

/** The router flags path matching follows. */
export type PathFlags = Partial<
  Pick<RouterFlags, 'ignoreTrailingSlash' | 'ignoreDuplicateSlashes' | 'useSemicolonDelimiter'>
>

// Encoded characters where decodeURIComponent(x) !== decodeURI(x): % # $ & + , / : ; = ? @
const RESERVED_ENCODINGS = new Set(['25', '23', '24', '26', '2B', '2C', '2F', '3A', '3B', '3D', '3F', '40'])

/** What a middleware's path matches: a prefix, on a segment boundary. */
export function compilePrefix(path: MiddlewarePath): RegExp {
  return pathToRegexp(typeof path === 'string' ? sanitizePrefix(path) : path.map(sanitizePrefix), { end: false }).regexp
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
export function normalizePath(url: string, flags: PathFlags): { path: string; error: Error | undefined } {
  let path = url

  if (path.charCodeAt(0) !== 47) {
    const absolute = pathFromAbsoluteURL(path)
    if (absolute === null) {
      return { path: url, error: malformedURL() }
    }
    path = absolute
  }

  if (flags.ignoreDuplicateSlashes) {
    path = removeDuplicateSlashes(path)
  }

  try {
    path = safeDecodeURI(path, flags.useSemicolonDelimiter === true)
  } catch {
    return { path: url, error: malformedURL() }
  }

  // The router keeps encoded slashes, but a literal `%` can still introduce one more encoded byte.
  path = path.replace(/%25([0-9A-Fa-f]{2})/g, '%$1')

  if (flags.ignoreTrailingSlash) {
    path = trimLastSlash(path)
  }

  return { path, error: undefined }
}

/**
 * What a Node middleware mounted at `prefix` sees as its URL: the rest of the path after the prefix, as sent where it
 * can be found in `url`, else as normalized, followed by the query.
 *
 * @param url - The URL as sent, query included.
 * @param normalized - Its path as {@link normalizePath} returned it.
 * @param match - What `prefix` matched in `normalized`.
 */
export function mountedURL(
  prefix: RegExp,
  url: string,
  normalized: string,
  match: RegExpExecArray,
  flags: PathFlags,
): string {
  const sanitized = sanitizeURL(url)
  const suffix = url.slice(sanitized.length)
  let rest: string

  const original = prefix.exec(sanitized)
  if (original !== null) {
    rest = sanitized.slice(original[0].length)
    if (flags.ignoreDuplicateSlashes) {
      rest = removeDuplicateSlashes(rest)
    }
    if (flags.ignoreTrailingSlash) {
      rest = trimLastSlash(rest)
    }
  } else {
    rest = normalized.slice(match[0].length)
  }

  if (rest[0] !== '/') {
    rest = '/' + rest
  }

  return rest + suffix
}

/**
 * A router's or a controller's middleware with each relative path rebased under `base`, that scope's full path:
 * `/jobs` added by a router at `/admin` matches `/admin/jobs`. A middleware with no path covers every route of the
 * scope already, and keeps none.
 *
 * A named parameter in `base` is kept and its regular expression dropped, which only widens a prefix the route
 * itself still checks.
 *
 * @throws ErrConfiguration when a path would be rebased under a wildcard or an optional parameter: neither has a
 *   prefix form.
 */
export function rebaseMiddlewares(base: string, middlewares: readonly ResolvedMiddleware[]): ResolvedMiddleware[] {
  return middlewares.map(middleware =>
    middleware.path === undefined ? middleware : { ...middleware, path: rebase(base, middleware.path) },
  )
}

function rebase(base: string, path: MiddlewarePath): MiddlewarePath {
  // `:name(regex)` reads as `:name` to the matcher; nothing else in a route path differs from it but these two.
  const prefix = base.replace(/:(\w+)\([^/]*\)/g, ':$1')

  if (/[*?]/.test(prefix)) {
    throw new ErrConfiguration(
      errMessage(
        `Cannot add middleware "${String(path)}" under "${base}": a relative path cannot start from a wildcard or ` +
          'an optional parameter',
      )
        .solutions(
          'Leave the path out, so the middleware covers every route of the router',
          'Or register it on the application with an absolute path, ".use(path, ...)"',
        )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  // `use('/')` joins to `/admin/`, which the matcher reads as `/admin`, as it reads a trailing slash on any prefix.
  const join = (relative: string): string => {
    const rooted = relative.startsWith('/') ? relative : `/${relative}`
    return `${prefix}${rooted}`
  }

  return typeof path === 'string' ? join(path) : path.map(join)
}

function sanitizePrefix(prefix: string): string {
  if (prefix === '/') {
    return ''
  }
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
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
function safeDecodeURI(path: string, useSemicolonDelimiter: boolean): string {
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
    } else if (charCode === 63 || charCode === 35 || (charCode === 59 && useSemicolonDelimiter)) {
      path = path.slice(0, i)
      break
    }
  }

  return shouldDecode ? decodeURI(path) : path
}

function removeDuplicateSlashes(path: string): string {
  return path.includes('//') ? path.replace(/\/\/+/g, '/') : path
}

function trimLastSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function malformedURL(): Error {
  return new ErrHTTPBadRequest('Cannot match the request path: the URL is malformed')
}
