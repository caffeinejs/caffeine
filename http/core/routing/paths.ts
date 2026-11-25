import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from '../error/common.js'
import type { RouterFlags } from '../matcher/matcher.js'

/** Joins a router base path and a route path, trimming a trailing slash (but never to empty). */
export function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

/**
 * The paths a route registers under. A prefixed root is served at the prefix and with a trailing slash, as Fastify's
 * `prefixTrailingSlash: 'both'` serves it.
 */
export function pathsOf(prefix: string | undefined, url: string, ignoreTrailingSlash: boolean): string[] {
  const path = url === '' ? '/' : url
  const base = prefix === undefined ? '' : prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  if (base === '') {
    return [path]
  }

  if (path === '/') {
    return ignoreTrailingSlash ? [base] : [base, `${base}/`]
  }

  return [base + path]
}

/** One piece of a route path, as {@link parseRoutePattern} reads it. */
export type RoutePatternPart =
  /** Literal text, `::` read as `:`. */
  | { readonly kind: 'text'; readonly text: string }
  /** A parameter, whose value lies within one segment; `regex` restricts it, without its parentheses. */
  | { readonly kind: 'param'; readonly name: string; readonly regex: string | undefined }
  /** `*`: the rest of the path. */
  | { readonly kind: 'wildcard' }
  /** Where the path's optional last segment starts: the path also matches without what follows. */
  | { readonly kind: 'optional' }

/** The router's optional segment: the path's last, starting with `:`, holding no regex, and ending in `?`. */
const OPTIONAL_SEGMENT = /\/:[^/()]*\?\/?$/

/**
 * A route path split as Caffeine's route syntax reads it. This syntax is what a `RouteMatcher` receives, whatever
 * router it matches with:
 *
 * - `:name` is a parameter. Its value lies within one segment, and its name ends at `(`, `-`, `.` or `/`, so text can
 *   follow it in its segment: `/files/:name.json`.
 * - `:name(regex)` restricts the value to what `regex` matches: `/at/:hour(^\d{2})h`.
 * - A `?` ending the path's last segment, when that segment starts with `:` and holds no regex, makes the segment
 *   optional: `/pets/:id?` matches `/pets` too, and `/reports/:id.json?` matches `/reports`.
 * - `::` is a literal `:`.
 * - `*` at the end of the path is a wildcard: it matches the rest of the path. After a parameter in its segment, a `*`
 *   is text: `/download/:id-file*name`.
 *
 * @throws ErrConfiguration when a parameter's regex is not closed.
 */
export function parseRoutePattern(path: string): RoutePatternPart[] {
  const optional = OPTIONAL_SEGMENT.exec(path)
  if (optional === null) {
    return scan(path, path)
  }

  // Read without the "?" that makes the segment optional.
  const segment = optional[0].replace(/\?(\/?)$/, '$1')
  return [...scan(path.slice(0, optional.index), path), { kind: 'optional' }, ...scan(segment, path)]
}

function scan(pattern: string, path: string): RoutePatternPart[] {
  const parts: RoutePatternPart[] = []
  let text = ''
  // A "*" after a parameter, in its segment, is text.
  let afterParam = false

  const flush = (): void => {
    if (text !== '') {
      parts.push({ kind: 'text', text })
      text = ''
    }
  }

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!

    if (char === ':' && pattern[i + 1] === ':') {
      text += ':'
      i++
    } else if (char === ':') {
      flush()
      const name = /^[^(\-./]*/.exec(pattern.slice(i + 1))![0]
      i += name.length
      let regex: string | undefined
      if (pattern[i + 1] === '(') {
        const end = endOfRegex(pattern, i + 1)
        if (end === pattern.length) {
          throw unclosedRegex(path, name)
        }
        regex = pattern.slice(i + 2, end)
        i = end
      }
      parts.push({ kind: 'param', name, regex })
      afterParam = true
    } else if (char === '*' && !afterParam) {
      flush()
      parts.push({ kind: 'wildcard' })
    } else {
      text += char
      afterParam &&= char !== '/'
    }
  }

  flush()
  return parts
}

function unclosedRegex(path: string, name: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(`Cannot read the route path "${path}": the regular expression of parameter "${name}" is not closed`)
      .solutions('Close it with ")"', 'Escape a literal parenthesis in it as "\\(" or "\\)"')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

/**
 * How many segments of a request path a route path spans: where the paths of the routes under it begin. A parameter
 * is one segment whatever its value, and under `ignoreDuplicateSlashes` a trailing slash folds into the path that
 * follows: `/v2/` spans two segments, and one when slashes fold.
 */
export function routePathSegments(path: string, flags: Partial<Pick<RouterFlags, 'ignoreDuplicateSlashes'>>): number {
  const joined = `${parseRoutePattern(path)
    .map(part => (part.kind === 'text' ? part.text : part.kind === 'optional' ? '' : 'p'))
    .join('')}/x`
  const folded = flags.ignoreDuplicateSlashes ? joined.replace(/\/{2,}/g, '/') : joined
  return folded.split('/').length - 2
}

/** The index of the `)` closing the regex that opens at `at`, escapes and nested groups included. */
function endOfRegex(pattern: string, at: number): number {
  let depth = 0

  for (let i = at; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++
    } else if (pattern[i] === '(') {
      depth++
    } else if (pattern[i] === ')' && --depth === 0) {
      return i
    }
  }

  return pattern.length
}
