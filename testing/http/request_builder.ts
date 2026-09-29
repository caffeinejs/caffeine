import { URLBuilder } from './url_builder.js'

/**
 * Builds a `RequestInit` fluently. A traditional builder (mirrors `ErrHTTPBuilder`) with two ergonomic
 * combos — {@link RequestInitBuilder.json} and {@link RequestInitBuilder.bearer} — plus optional URL
 * parts ({@link RequestInitBuilder.path}/{@link RequestInitBuilder.query}) consumed only by
 * {@link RequestInitBuilder.toRequest}.
 */
export function newReq(): RequestInitBuilder {
  return new RequestInitBuilder()
}

export class RequestInitBuilder {
  #method?: string
  readonly #headers = new Headers()
  #body?: RequestInit['body']
  #path?: string
  readonly #query: [string, string][] = []
  readonly #init: { redirect?: RequestInit['redirect']; signal?: RequestInit['signal'] } = {}

  method(method: string): this {
    this.#method = method
    return this
  }

  header(name: string, value: string): this {
    this.#headers.set(name, value)
    return this
  }

  headers(headers: RequestInit['headers']): this {
    for (const [name, value] of new Headers(headers)) {
      this.#headers.set(name, value)
    }
    return this
  }

  body(body: RequestInit['body']): this {
    this.#body = body
    return this
  }

  redirect(redirect: RequestInit['redirect']): this {
    this.#init.redirect = redirect
    return this
  }

  signal(signal: RequestInit['signal']): this {
    this.#init.signal = signal
    return this
  }

  // Sets a JSON body and the matching content-type header.
  json(value: unknown): this {
    this.#body = JSON.stringify(value)
    this.#headers.set('content-type', 'application/json')
    return this
  }

  // Sets the Authorization header to a bearer token.
  bearer(token: string): this {
    this.#headers.set('authorization', `Bearer ${token}`)
    return this
  }

  // Path/query are URL concerns — they are only consumed by toRequest(), never by build().
  path(path: string): this {
    this.#path = path
    return this
  }

  query(name: string, value: string | number): this {
    this.#query.push([name, String(value)])
    return this
  }

  queries(queries: Record<string, string | number>): this {
    for (const [name, value] of Object.entries(queries)) {
      this.query(name, value)
    }
    return this
  }

  build(): RequestInit {
    const init: RequestInit = { ...this.#init, headers: this.#headers }
    if (this.#method !== undefined) {
      init.method = this.#method
    }
    if (this.#body !== undefined) {
      init.body = this.#body
      // A streaming body requires duplex: 'half'; harmless for string bodies.
      ;(init as RequestInit & { duplex?: 'half' }).duplex = this.#body === null ? undefined : 'half'
    }
    return init
  }

  /**
   * Builds a full `Request` from `path()`/`query()` plus the accumulated init. Absolute via a default
   * `http://localhost` origin — the client rebases it onto its own origin.
   *
   * @throws Error when no path was set.
   */
  toRequest(): Request {
    if (this.#path === undefined) {
      throw new Error('Cannot build request: no path set — call path() first')
    }
    const url = new URLBuilder(this.#path)
    for (const [name, value] of this.#query) {
      url.query(name, value)
    }
    return new Request(url.build(), this.build())
  }
}
