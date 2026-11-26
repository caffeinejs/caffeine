import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from '../error/common.js'

/**
 * The paths a route registers under. `base` is its group's whole path and `routePath` its own, both normalized. A
 * route at `/` is the group's own path, served at `/r` and `/r/`, as Fastify's `prefixTrailingSlash: 'both'` serves
 * it; once when the router ignores trailing slashes, under a wildcard, or under a group path that is one optional
 * segment, whose two forms collide.
 */
export function pathsOf(base: string, routePath: string, ignoreTrailingSlash: boolean): string[] {
  if (routePath !== '/') {
    return [base + routePath]
  }

  if (base === '') {
    return ['/']
  }

  const parts = partsOf(base)
  if (ignoreTrailingSlash || parts.some(part => part.kind === 'wildcard') || parts[0]?.kind === 'optional') {
    return [base]
  }

  return [base, `${base}/`]
}

/**
 * The URL a route answers at first, its prefix, group path and route path joined as the server joins them. Each
 * part is normalized here, so a raw path from configuration may be passed.
 *
 * @throws ErrConfiguration when a part holds an empty segment, "//".
 */
export function routeURL(prefix: string | undefined, groupPath: string, routePath: string): string {
  const base = (prefix === undefined ? '' : normalizeGroupPath(prefix)) + normalizeGroupPath(groupPath)
  return pathsOf(base, normalizeRoutePath(routePath), true)[0]!
}

/** One piece of a route path, as {@link parseRoutePattern} reads it. */
export type RoutePatternPart =
  /** Literal text, `::` read as `:`. */
  | { readonly kind: 'text'; readonly text: string }
  /** A parameter, whose value lies within one segment; `regex` restricts it, without its parentheses. */
  | { readonly kind: 'param'; readonly name: string; readonly regex: string | undefined }
  /** `*`: the rest of the path. */
  | { readonly kind: 'wildcard' }
  /**
   * Where the path's optional last segment starts: the path also matches without what follows. A `/` that ends the
   * path stays: `/items/:id?/` also matches `/items/`.
   */
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
 * @throws ErrConfiguration when a parameter's regex is not closed, or a wildcard does not end the path.
 */
export function parseRoutePattern(path: string): RoutePatternPart[] {
  const parts = partsOf(path)
  const wildcard = parts.findIndex(part => part.kind === 'wildcard')

  if (wildcard !== -1 && wildcard !== parts.length - 1) {
    throw new ErrConfiguration(
      errMessage(`Cannot read the route path "${path}": a wildcard "*" must end the path`)
        .solutions(
          'Move the "*" to the end of the path',
          'Put a literal "*" after text that ends a parameter\'s name, such as ":id-file*name"',
        )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return parts
}

// The parts of a route path, without the check on where a wildcard stands.
function partsOf(path: string): RoutePatternPart[] {
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
 * A group, router, controller, prefix or mount path, or a plugin path that becomes one: rooted, without a trailing
 * `/`. The root is `''`.
 *
 * @throws ErrConfiguration when the path holds an empty segment, `//`.
 */
export function normalizeGroupPath(path: string): string {
  assertNoEmptySegment(path)
  return trimTrailingSlashes(rooted(path))
}

/**
 * A route path: rooted, a trailing `/` kept. The root is `/`.
 *
 * @throws ErrConfiguration when the path holds an empty segment, `//`.
 */
export function normalizeRoutePath(path: string): string {
  assertNoEmptySegment(path)
  return rooted(path)
}

/**
 * A path compared as plain text, such as a base path, a CSRF exclusion or a middleware prefix: rooted, without a
 * trailing `/`. The root is `''`.
 *
 * @throws ErrConfiguration when the path holds `//`.
 */
export function normalizeLiteralPath(path: string): string {
  if (path.includes('//')) {
    throw emptySegment(path)
  }

  return trimTrailingSlashes(rooted(path))
}

/** A literal path prefix: the path itself, and everything under it on whole segments. */
export interface LiteralPrefix {
  readonly exact: string
  readonly under: string
}

/**
 * The prefix `path` names: `/a/` covers `/a` and `/a/b`, not `/ab`.
 *
 * @throws ErrConfiguration when the path holds `//`.
 */
export function literalPrefix(path: string): LiteralPrefix {
  const exact = normalizeLiteralPath(path)
  return { exact, under: `${exact}/` }
}

/** Whether `path` is `prefix` itself or under it. */
export function underPrefix(path: string, prefix: LiteralPrefix): boolean {
  return path === prefix.exact || path.startsWith(prefix.under)
}

// Read as text, so a "//" inside a parameter's regex is not an empty segment.
function assertNoEmptySegment(path: string): void {
  const text = partsOf(path)
    .map(part => (part.kind === 'text' ? part.text : part.kind === 'param' ? 'p' : part.kind === 'wildcard' ? '*' : ''))
    .join('')

  if (text.includes('//')) {
    throw emptySegment(path)
  }
}

function emptySegment(path: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(`Cannot use the path "${path}": it holds an empty segment, "//"`)
      .solutions('Write a single "/" between segments')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function rooted(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
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
    .map(part => (part.kind === 'text' ? part.text : part.kind === 'optional' ? '' : 'p'))
    .join('')}/x`
  return joined.split('/').length - 2
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
