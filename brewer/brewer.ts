import type { HeaderValues, RawBody } from './platform.js'
import type { BrewClient } from './tree.js'
import { buildQuery, fillPath, joinURL } from './url.js'
import { isVerb } from './verbs.js'

/** How the client reaches the server, and what every request starts from. */
export interface BrewOptions extends Omit<RequestInit, 'method' | 'body' | 'headers'> {
  /**
   * Headers sent with every request. A function is called per request — sync or async — so a token can be read
   * when it is needed rather than captured when the client was made.
   */
  headers?: HeaderValues | (() => HeaderValues | Promise<HeaderValues>)

  /** The `fetch` to call. Defaults to the global one; supply another for a test or a non-global implementation. */
  fetch?: Fetchable['fetch']
}

/**
 * Anything that answers a request the way `fetch` does — a running application, or a stub standing in for one.
 *
 * Structural on purpose: this package does not depend on the server, so a `WebApplication` satisfies it by having
 * the method rather than by being imported.
 */
export interface Fetchable {
  fetch(input: Request | string | URL, options?: RequestInit): Promise<Response>
}

/** Where a client built over a {@link Fetchable} addresses its requests, since there is no origin to speak of. */
const IN_PROCESS_ORIGIN = 'http://localhost'

/** What one call adds on top of the client's own options. */
interface RequestArgs {
  params?: Record<string, unknown>
  query?: unknown
  body?: unknown
  headers?: HeaderValues
  [key: string]: unknown
}

/**
 * A typed client for an application or a router.
 *
 * Routes are reached by property access, path parameters by calling the segment that binds them, and the request
 * by the verb that ends the chain. Nothing describes the API twice: the type argument *is* the server's.
 *
 * ```ts
 * const client = brewer<App>('http://localhost:3000')
 *
 * const res = await client.pets({ id: 1 }).get()
 * if (res.ok) {
 *   const pet = await res.json()
 * }
 * ```
 *
 * Given the application itself rather than a URL, requests go through its own `fetch` and never reach a socket —
 * which is what a test wants. Both the routes and the transport come from the one argument, so neither the type
 * argument nor the URL is written:
 *
 * ```ts
 * await app.ready()
 * const client = brewer(app)
 * ```
 *
 * The application has to be ready first: an application that has not been set up has registered no routes, so
 * every call comes back 404.
 *
 * @param options - `fetch` overrides the transport, an application target included.
 */
export function brewer<T>(baseURL: string, options?: BrewOptions): BrewClient<T>
export function brewer<T extends Fetchable>(target: T, options?: BrewOptions): BrewClient<T>
export function brewer<T>(target: Fetchable, options?: BrewOptions): BrewClient<T>
export function brewer<T>(target: string | Fetchable, options: BrewOptions = {}): BrewClient<T> {
  if (typeof target === 'string') {
    return node(target, options, [], undefined) as BrewClient<T>
  }

  // Bound because an application's `fetch` reads its adapter off `this`.
  const resolved: BrewOptions = { ...options, fetch: options.fetch ?? target.fetch.bind(target) }

  return node(IN_PROCESS_ORIGIN, resolved, [], undefined) as BrewClient<T>
}

// A node of the proxy: the segments walked so far, and the method once a verb has been read. Built over a function
// target so one object can be both called — to supply a parameter, or to send the request — and indexed.
function node(baseURL: string, options: BrewOptions, segments: readonly string[], method: string | undefined): unknown {
  return new Proxy(target, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }

      // The escape hatch, only ever reachable from the root — a nested `$request` would have segments to ignore.
      if (prop === '$request' && segments.length === 0) {
        return (verb: string, path: string, init: RequestArgs = {}) =>
          send(baseURL, options, fillPath(path, init.params), verb, init)
      }

      if (method === undefined && isVerb(prop)) {
        return node(baseURL, options, segments, prop.toUpperCase())
      }

      return node(baseURL, options, [...segments, prop], method)
    },

    apply(_target, _thisArg, args: unknown[]) {
      if (method !== undefined) {
        return send(baseURL, options, `/${segments.join('/')}`, method, (args[0] ?? {}) as RequestArgs)
      }

      // A parameter segment binds exactly one name, so the single value is unambiguous — which is what lets the
      // runtime stay this small: it never has to know the path shape the types know.
      const [name, value] = Object.entries((args[0] ?? {}) as Record<string, unknown>)[0] ?? ['', '']
      const encoded = name === '*' ? String(value) : encodeURIComponent(String(value))

      return node(baseURL, options, [...segments, encoded], method)
    },
  })
}

async function send(
  baseURL: string,
  options: BrewOptions,
  path: string,
  method: string,
  init: RequestArgs,
): Promise<Response> {
  const { params: _params, query, body, headers, ...rest } = init
  const url = `${joinURL(baseURL, path)}${buildQuery(query)}`

  const merged = new Headers(await resolveHeaders(options.headers))
  for (const [key, value] of new Headers(headers).entries()) {
    merged.set(key, value)
  }

  // A body the platform already knows how to send is passed through untouched, so an upload keeps its own
  // content type and its own encoding. Everything else is JSON.
  let payload: RawBody | undefined
  if (body !== undefined && body !== null) {
    if (isRawBody(body)) {
      payload = body
    } else {
      payload = JSON.stringify(body)
      if (!merged.has('content-type')) {
        merged.set('content-type', 'application/json')
      }
    }
  }

  const { headers: _clientHeaders, fetch: fetchImpl, ...clientRest } = options

  return (fetchImpl ?? globalThis.fetch)(url, {
    ...clientRest,
    ...rest,
    method,
    headers: merged,
    body: payload as RequestInit['body'],
  })
}

function resolveHeaders(headers: BrewOptions['headers']): HeaderValues | Promise<HeaderValues> | undefined {
  return typeof headers === 'function' ? headers() : headers
}

function isRawBody(body: unknown): body is RawBody {
  return (
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    body instanceof ReadableStream ||
    ArrayBuffer.isView(body)
  )
}

/**
 * The proxy's target, and never called.
 *
 * A function rather than an object so one node can be both indexed — for a static segment — and called, either to
 * supply a path parameter or to send the request. Every operation is trapped; nothing reaches this.
 */
function target(): void {
  return undefined
}
