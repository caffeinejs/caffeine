import { joinURL } from '@caffeinejs/brewer'

import { ErrMissingRouteParam } from './error.js'

/**
 * Builds a concrete URL string from a path template. Decoupled from the router — it takes a plain
 * `/pets/:id` template, never a controller. Fill `:name` segments with {@link URLBuilder.param}; the
 * result feeds `new Request(url, ...)` or {@link controllerClient}/{@link controllerTypedClient} (the client honors a
 * Request's URL, so this is how `/pets/:id` becomes `/pets/123`).
 */
export function newURL(path: string): URLBuilder {
  return new URLBuilder(path)
}

export class URLBuilder {
  readonly #path: string
  readonly #params = new Map<string, string>()
  readonly #query = new URLSearchParams()
  #baseURL = 'http://localhost'

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
   * @throws ErrMissingRouteParam when a `:name` segment has no matching param.
   */
  build(): string {
    // A path is joined onto the base URL, never resolved against it: the base URL may name the application's base
    // path, and has to keep it. A full URL — what `build()` itself returns — is kept as it is.
    const path = substitute(this.#path, this.#params)
    const url = URL.canParse(path) ? new URL(path) : new URL(joinURL(this.#baseURL.replace(/\/+$/, ''), path))

    for (const [key, value] of this.#query) {
      url.searchParams.append(key, value)
    }

    return url.toString()
  }
}

// Replaces each `:name` segment with the matching param value. Throws when a segment has no value, so a
// param route is never silently built with a literal ":name" in the path.
function substitute(path: string, params: Map<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params.get(name)
    if (value === undefined) {
      throw new ErrMissingRouteParam(name, path)
    }
    return encodeURIComponent(value)
  })
}
