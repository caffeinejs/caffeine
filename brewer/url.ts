import { encodeParam } from './_path.js'
import { ErrBrewPathParam } from './errors.js'

/**
 * Substitutes a path's parameters, for a path addressed by `$request`.
 *
 * The proxy does not come through here — it has the values already, one segment at a time. A `*` keeps its
 * slashes, since carrying them is the whole point of a wildcard; every part between them is encoded like any other
 * value.
 *
 * @throws ErrBrewPathParam - A parameter the path requires, a wildcard included, has no value.
 * @throws ErrBrewPathValue - A value is `.` or `..`, or a wildcard holds one as a part.
 */
export function fillPath(path: string, params: Record<string, unknown> | undefined): string {
  if (!path.includes(':') && !path.includes('*')) {
    return path
  }

  return path
    .split('/')
    .map(segment => {
      if (segment !== '*' && !segment.startsWith(':')) {
        return segment
      }

      const optional = segment.endsWith('?')
      const constraint = segment.indexOf('(')
      const name =
        segment === '*' ? '*' : segment.slice(1, constraint === -1 ? undefined : constraint).replace(/\?$/, '')
      const value = params?.[name]

      if (value === undefined || value === null) {
        if (optional) {
          return undefined
        }

        throw new ErrBrewPathParam(path, name)
      }

      return encodeParam(path, name, value)
    })
    .filter(segment => segment !== undefined)
    .join('/')
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
