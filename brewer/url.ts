import { encodeParam } from './_path.js'
import { ErrBrewPathParam, ErrBrewPathValue } from './errors.js'

/**
 * Substitutes a path's parameters, for a path addressed by `$request`.
 *
 * The proxy does not come through here — it has the values already, one segment at a time. A `*` keeps its
 * slashes, since carrying them is the whole point of a wildcard; every part between them is encoded like any other
 * value. A segment may hold several parameters and text of its own, read as the router reads them:
 * `/near/:lat-:lng` takes `{ lat, lng }`, `/files/:name.json` takes `{ name }`, and `::` is a literal colon.
 *
 * @throws ErrBrewPathParam - A parameter the path requires, a wildcard included, has no value.
 * @throws ErrBrewPathValue - A value is `.` or `..`, a wildcard holds one as a part, or a segment is one once filled.
 */
export function fillPath(path: string, params: Record<string, unknown> | undefined): string {
  if (!path.includes(':') && !path.includes('*')) {
    return path
  }

  return path
    .split('/')
    .map(segment => {
      if (segment === '*') {
        return fillParams(path, ['*'], params, false)?.[0]
      }

      if (!segment.includes(':')) {
        return segment
      }

      // The router reads a trailing `?` as optional only on a segment that starts with its parameter and holds no
      // constraint. Anywhere else the `?` is part of a name, as `item-:id?` binds `id?`, or text after a constraint.
      const optional = segment.startsWith(':') && segment.endsWith('?') && !/[()]/.test(segment)
      const parts = readSegment(optional ? segment.slice(0, -1) : segment)
      const names = parts.filter(part => typeof part !== 'string').map(part => part.name)
      const values = fillParams(path, names, params, optional)

      if (values === undefined) {
        return undefined
      }

      let next = 0
      const filled = parts
        .map((part, index) => (typeof part === 'string' ? escapeText(part, index === 0) : values[next++]))
        .join('')

      // Each value was refused as a step on its own; empty ones can still leave the segment as one.
      if (filled === '.' || filled === '..') {
        throw new ErrBrewPathValue(path, segment, filled, 'segment')
      }

      return filled
    })
    .filter(segment => segment !== undefined)
    .join('/')
}

// Text beside a parameter, written the way find-my-way 9.9.0 matches it. Before the segment's first parameter it is a
// static node, which takes a `%` as `%25` and every other character as written. After one it is matched by that
// parameter's expression against the decoded segment, in which the router holds a `%` as `%25`.
function escapeText(text: string, leading: boolean): string {
  const held = text.replaceAll('%', '%25')

  return leading ? held : encodeURIComponent(held)
}

// The encoded value of each name, in order, or `undefined` for an optional segment given none of them: the router
// drops such a segment whole, so once one is given, every other one is required.
function fillParams(
  path: string,
  names: readonly string[],
  params: Record<string, unknown> | undefined,
  optional: boolean,
): string[] | undefined {
  const given = (name: string) => params?.[name] !== undefined && params[name] !== null

  if (optional && !names.some(given)) {
    return undefined
  }

  return names.map(name => {
    if (!given(name)) {
      throw new ErrBrewPathParam(path, name)
    }

    return encodeParam(path, name, params?.[name])
  })
}

/**
 * One segment as find-my-way reads it: text, and the parameters within it.
 *
 * A single `:` starts a parameter, whose name ends at `(`, `-` or `.`. A `(` opens a constraint, which runs to its
 * balancing `)`, nested ones counted and a `\` escaping the character after it, or to the end of the segment when
 * it never closes. Text then runs to the next single `:`; `::` is a literal colon.
 */
function readSegment(segment: string): Array<string | { readonly name: string }> {
  const parts: Array<string | { readonly name: string }> = []
  let text = ''
  let i = 0

  while (i < segment.length) {
    if (segment[i] !== ':') {
      text += segment[i++]
      continue
    }

    if (segment[i + 1] === ':') {
      text += ':'
      i += 2
      continue
    }

    let end = i + 1
    while (end < segment.length && !'(-.'.includes(segment[end])) {
      end++
    }

    parts.push(text, { name: segment.slice(i + 1, end) })
    text = ''
    i = segment[end] === '(' ? afterConstraint(segment, end) : end
  }

  parts.push(text)

  return parts
}

// The index just past the `)` balancing the `(` at `open`, or the segment's length when none does.
function afterConstraint(segment: string, open: number): number {
  let depth = 0

  for (let i = open; i < segment.length; i++) {
    if (segment[i] === '\\') {
      i++
    } else if (segment[i] === '(') {
      depth++
    } else if (segment[i] === ')' && --depth === 0) {
      return i + 1
    }
  }

  return segment.length
}

/**
 * Renders the query string.
 *
 * An array becomes repeated keys, which is what the server's parser reads back as an array; `undefined` and `null`
 * are left out entirely rather than sent as the strings "undefined" and "null".
 */
export function buildQuery(query: unknown): string {
  if (query === undefined || query === null) {
    return ''
  }

  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          search.append(key, String(item))
        }
      }
      continue
    }

    search.append(key, String(value))
  }

  const rendered = search.toString()

  return rendered === '' ? '' : `?${rendered}`
}

/** Joins the client's base URL with a request path, tolerating a slash on either side of the seam or neither. */
export function joinURL(baseURL: string, path: string): string {
  const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
  const rest = path === '' || path === '/' ? '' : path.startsWith('/') ? path : `/${path}`

  return `${base}${rest}`
}
