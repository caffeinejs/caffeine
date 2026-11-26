import { fillPath, joinURL } from '@caffeinejs/brewer'

import { withoutTrailingSlashes } from './_util.js'

/** The origin a URL is built on unless a base URL is given: the test client rebases it onto its own. */
export const LOCAL_ORIGIN = 'http://localhost'

/**
 * Builds a concrete URL string from a path template. Decoupled from the router — it takes a plain
 * `/pets/:id` template, never a controller. Fill its parameters with {@link URLBuilder.param}, a wildcard's under
 * `'*'`, as the typed client fills them; the result feeds `new Request(url, ...)` or
 * {@link controllerClient}/{@link controllerTypedClient} (the client honors a Request's URL, so this is how
 * `/pets/:id` becomes `/pets/123`).
 */
export function newURL(path: string): URLBuilder {
  return new URLBuilder(path)
}

export class URLBuilder {
  readonly #path: string
  readonly #params = new Map<string, string>()
  readonly #query = new URLSearchParams()
  #baseURL = LOCAL_ORIGIN

  constructor(path: string) {
    this.#path = path
  }

  param(name: string, value: string | number): this {
    this.#params.set(name, String(value))
    return this
  }

  query(name: string, value: string | number): this {
    this.#query.append(name, String(value))
    return this
  }

  baseURL(baseURL: string | URL): this {
    this.#baseURL = baseURL.toString()
    return this
  }

  /**
   * @throws ErrBrewPathParam when a parameter the path names, a wildcard's included, has no value.
   * @throws ErrBrewPathValue when a value is `.` or `..`.
   */
  build(): string {
    // Only the path is a template, filled as the typed client fills it: a full URL keeps its scheme, host and port,
    // and a query is sent as written.
    const absolute = URL.canParse(this.#path)
    const start = absolute ? pathStart(this.#path) : 0
    const end = start + queryStart(this.#path.slice(start))
    const filled =
      this.#path.slice(0, start) +
      fillPath(this.#path.slice(start, end), Object.fromEntries(this.#params)) +
      this.#path.slice(end)

    return urlOf(filled, this.#baseURL, this.#query)
  }
}

/**
 * The URL a concrete `path` names: a full URL as it is, a path joined onto `baseURL`, never resolved against it, since
 * the base URL may name the application's base path and has to keep it. Each of `query` is appended.
 */
export function urlOf(path: string, baseURL: string, query: URLSearchParams): string {
  const url = URL.canParse(path) ? new URL(path) : new URL(joinURL(withoutTrailingSlashes(baseURL), path))

  for (const [key, value] of query) {
    url.searchParams.append(key, value)
  }

  return url.toString()
}

// Where a full URL's path starts: after its scheme and authority. A URL with no authority has no path to fill.
function pathStart(url: string): number {
  const scheme = url.indexOf('://')
  if (scheme === -1) {
    return url.length
  }

  const at = url.slice(scheme + 3).search(/[/?#]/)
  return at === -1 ? url.length : scheme + 3 + at
}

// Where a path template's query starts: a `?` or `#` outside a parameter's regex, a `?` ending the path, before a
// final `/` or not, excepted, which makes its last segment optional.
function queryStart(path: string): number {
  let depth = 0

  for (let i = 0; i < path.length; i++) {
    const char = path[i]
    if (char === '\\') {
      i++
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (char === '#' || (char === '?' && !/^\/?$/.test(path.slice(i + 1))))) {
      return i
    }
  }

  return path.length
}
