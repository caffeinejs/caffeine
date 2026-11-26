import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from '../error/common.js'

/** The path a route registers under: its group's whole path and its own, both normalized. */
export function joinRoutePath(base: string, routePath: string): string {
  return routePath === '/' ? base || '/' : base + routePath
}

/**
 * The URL a route answers at, its prefix, group path and route path joined as the server joins them. Each part is
 * normalized here, so a raw path from configuration may be passed.
 *
 * @throws ErrConfiguration when the prefix or the group path holds a wildcard or an optional segment.
 */
export function routeURL(prefix: string | undefined, groupPath: string, routePath: string): string {
  const base = (prefix === undefined ? '' : normalizeGroupPath(prefix)) + normalizeGroupPath(groupPath)
  return joinRoutePath(base, normalizeRoutePath(routePath))
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
 * - `*` is a wildcard: it matches the rest of the path, so the router refuses one that does not end it. After a
 *   parameter in its segment, a `*` is text: `/download/:id-file*name`.
 */
export function parseRoutePattern(path: string): RoutePatternPart[] {
  const optional = OPTIONAL_SEGMENT.exec(path)
  if (optional === null) {
    return scan(path)
  }

  // Read without the "?" that makes the segment optional.
  const segment = optional[0].replace(/\?(\/?)$/, '$1')
  return [...scan(path.slice(0, optional.index)), { kind: 'optional' }, ...scan(segment)]
}

function scan(pattern: string): RoutePatternPart[] {
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

  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]!

    if (char === ':' && pattern[i + 1] === ':') {
      text += ':'
      i += 2
    } else if (char === ':') {
      flush()
      const name = /^[^(\-./]*/.exec(pattern.slice(i + 1))![0]
      i += 1 + name.length
      let regex: string | undefined
      if (pattern[i] === '(') {
        // An unclosed regex runs to the end of the path: the router refuses it when the route registers.
        const end = endOfRegex(pattern, i)
        regex = pattern.slice(i + 1, end)
        i = end + 1
      }
      parts.push({ kind: 'param', name, regex })
      afterParam = true
    } else if (char === '*' && !afterParam) {
      flush()
      parts.push({ kind: 'wildcard' })
      i++
    } else {
      text += char
      afterParam &&= char !== '/'
      i++
    }
  }

  flush()
  return parts
}

/**
 * A router, group, controller, prefix or mount path, or a plugin path that becomes one: rooted, without a trailing
 * `/`. The root is `''`. Such a path holds literal segments and parameters only.
 *
 * @throws ErrConfiguration when the path holds a wildcard or an optional segment.
 */
export function normalizeGroupPath(path: string): string {
  if (parseRoutePattern(path).some(part => part.kind === 'wildcard' || part.kind === 'optional')) {
    throw new ErrConfiguration(
      errMessage(`Cannot use "${path}" as a router path: it holds a wildcard or an optional segment`)
        .solutions(
          'Put the wildcard or the optional segment on a route: a router, group, controller or mount path holds literal segments and parameters only',
        )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return normalizeLiteralPath(path)
}

/** A route path: rooted, without a trailing `/`. The root is `/`. */
export function normalizeRoutePath(path: string): string {
  return trimTrailingSlashes(rooted(path)) || '/'
}

/**
 * A path compared as plain text, such as a base path, a CSRF exclusion or a middleware prefix: rooted, without a
 * trailing `/`. The root is `''`.
 */
export function normalizeLiteralPath(path: string): string {
  return trimTrailingSlashes(rooted(path))
}

/** A literal path prefix: the path itself, and everything under it on whole segments. */
export interface LiteralPrefix {
  readonly exact: string
  readonly under: string
}

/** The prefix `path` names: `/a/` covers `/a` and `/a/b`, not `/ab`. */
export function literalPrefix(path: string): LiteralPrefix {
  const exact = normalizeLiteralPath(path)
  return { exact, under: `${exact}/` }
}

/** Whether `path` is `prefix` itself or under it. */
export function underPrefix(path: string, prefix: LiteralPrefix): boolean {
  return path === prefix.exact || path.startsWith(prefix.under)
}

// A leading run of "/" is one: a path starting "//" names another host to a browser.
function rooted(path: string): string {
  let start = 0
  while (path[start] === '/') {
    start++
  }

  return `/${path.slice(start)}`
}

// A loop, not `/\/+$/`: that backtracks quadratically over a long run of slashes followed by anything else.
function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') {
    end--
  }

  return path.slice(0, end)
}

/**
 * How many segments of a request path a route path spans: where the paths of the routes under it begin. A parameter
 * is one segment whatever its value: `/tenants/:id` spans two.
 */
export function routePathSegments(path: string): number {
  const joined = `${parseRoutePattern(path)
    .map(part => (part.kind === 'text' ? part.text : 'p'))
    .join('')}/x`
  return joined.split('/').length - 2
}

/**
 * The keys the router files a route path under, to tell whether two route paths are one path to it: a parameter by
 * its place and its regex, not its name, and a path with an optional last segment under each of its forms.
 */
export function routeKeys(path: string): string[] {
  const keys: string[] = []
  let key = ''

  for (const part of parseRoutePattern(path)) {
    switch (part.kind) {
      case 'text':
        key += part.text
        break
      case 'param':
        // Not a character a path holds: a parameter never reads as text. The router files a regex without its
        // anchors.
        key += `\u0000${anchorless(part.regex ?? '')}\u0000`
        break
      case 'wildcard':
        key += '\u0001'
        break
      case 'optional':
        keys.push(key || '/')
        break
    }
  }

  return [key, ...keys]
}

function anchorless(regex: string): string {
  const start = regex.startsWith('^') ? 1 : 0
  const end = regex.endsWith('$') ? regex.length - 1 : regex.length
  return regex.slice(start, Math.max(start, end))
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
