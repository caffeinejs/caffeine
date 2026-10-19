import { discard } from './_discard.js'
import { encodeParam } from './_path.js'
import { authenticate, MAX_FOLLOW_UPS, type Answering, type Authenticator } from './authenticator.js'
import { fileOf, filenameOf } from './download.js'
import type { FileHelpers } from './files.js'
import { formData } from './form.js'
import { intercept, type Interceptor } from './interceptor.js'
import type { HeaderValues, RawBody } from './platform.js'
import { progress } from './progress.js'
import type { BrewClient } from './tree.js'
import { buildQuery, fillPath, joinURL } from './url.js'
import { isVerb } from './verbs.js'

/** How the client reaches the server, and what every request starts from. */
export interface BrewOptions extends Omit<RequestInit, 'method' | 'body' | 'headers'> {
  /**
   * Headers sent with every request. A function is called per request — sync or async — so a token can be read
   * when it is needed rather than captured when the client was made. A name given `undefined` is left out, so a
   * token not known yet sends no header at all. A `content-type` here or on a call never reaches a `FormData` or
   * `URLSearchParams` body, which goes with the type the platform writes for it. One here does not reach a `Blob`
   * that has a type either: it goes under its own, unless the call names another.
   */
  headers?: HeaderValues | (() => HeaderValues | Promise<HeaderValues>)

  /**
   * The `fetch` to call. Defaults to the global one; supply another for a test or a non-global implementation.
   *
   * It is called with the URL and the init, or, on a client with interceptors or an authenticator, with one `Request`
   * carrying both.
   */
  fetch?: Fetchable['fetch']

  /**
   * Run around every request, the first listed seeing the request first and the response last.
   *
   * They are handed a `Request`, whose URL is absolute: a base URL that is only a path is resolved against the page,
   * so outside a browser such a client rejects every call.
   */
  interceptors?: readonly Interceptor[]

  /**
   * Answers a 401 with a follow-up carrying credentials, around the interceptors: see {@link Authenticator}. Like
   * interceptors, it has the client hand its `fetch` a `Request`.
   */
  authenticator?: Authenticator

  /** The follow-ups the authenticator may send in one call: 3 unless set. At 0, the first 401 rejects unasked. */
  maxFollowUps?: number
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

/** What the root answers beside its routes, under the names `FileHelpers` gives them. */
const fileHelpers: FileHelpers = { $file: fileOf, $filename: filenameOf, $progress: progress, $formData: formData }

/** The bodies `fetch` sends as they are, by the brand each carries whatever realm made it. */
const RAW_BODIES = new Set(['Blob', 'File', 'FormData', 'URLSearchParams', 'ArrayBuffer', 'ReadableStream'])

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
 * await app.bootstrap()
 * const client = brewer(app)
 * ```
 *
 * The application has to be ready first: before `bootstrap()` or `run()`, every call rejects with
 * `ErrApplicationNotReady`.
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

/** A segment the proxy walked: a name as written, or a path parameter, encoded when the request is sent. */
type Segment = string | { readonly name: string; readonly value: unknown }

// A node of the proxy: the segments walked so far, and the method once a verb has been read. Its target is the call
// itself — to supply a parameter, or to send the request — so one object can be both called and indexed.
function node(
  baseURL: string,
  options: BrewOptions,
  segments: readonly Segment[],
  method: string | undefined,
): unknown {
  const call = (init: Record<string, unknown> = {}): unknown => {
    if (method !== undefined) {
      return send(baseURL, options, () => pathOf(segments), method, init)
    }

    // A parameter segment binds exactly one name, so the single value is unambiguous — which is what lets the
    // runtime stay this small: it never has to know the path shape the types know. An optional parameter given
    // no value adds no segment, as `fillPath` leaves it out.
    const [name, value] = Object.entries(init)[0] ?? ['', undefined]
    if (value === undefined || value === null) {
      return node(baseURL, options, segments, method)
    }

    return node(baseURL, options, [...segments, { name, value }], method)
  }

  return new Proxy(call, {
    get(_target, prop) {
      // Nor `then`: whatever is awaited is asked for it, and a node answering it would be taken for a promise that
      // never settles.
      if (typeof prop !== 'string' || prop === 'then') {
        return undefined
      }

      if (segments.length === 0) {
        // The escape hatch, only ever reachable from the root — a nested `$request` would have segments to ignore.
        // Upper-cased because `fetch` normalises only the six methods the standard names, and a route may be
        // declared in lower case.
        if (prop === '$request') {
          return (verb: string, path: string, init: RequestArgs = {}) =>
            send(baseURL, options, () => fillPath(path, init.params), verb.toUpperCase(), init)
        }

        if (Object.hasOwn(fileHelpers, prop)) {
          return fileHelpers[prop as keyof FileHelpers]
        }
      }

      if (method === undefined && isVerb(prop)) {
        return node(baseURL, options, segments, prop.toUpperCase())
      }

      return node(baseURL, options, [...segments, prop], method)
    },
  })
}

/** The path the segments spell, each parameter encoded. */
function pathOf(segments: readonly Segment[]): string {
  // How the route reads — `/users/:id` — named by a value the path refuses to carry.
  const route = `/${segments.map(segment => (typeof segment === 'string' ? segment : marker(segment.name))).join('/')}`
  const parts = segments.map(segment =>
    typeof segment === 'string' ? segment : encodeParam(route, segment.name, segment.value),
  )

  return `/${parts.join('/')}`
}

function marker(name: string): string {
  return name === '*' ? '*' : `:${name}`
}

// The path is built here, inside the promise, so a path the call cannot fill rejects like any other failure.
async function send(
  baseURL: string,
  options: BrewOptions,
  path: () => string,
  method: string,
  init: RequestArgs,
): Promise<Response> {
  const { params: _params, query, body, headers, ...rest } = init
  const url = `${joinURL(baseURL, path())}${buildQuery(query)}`
  // A body given as a function is a stream it opens when the request is sent.
  const opens = typeof body === 'function'
  const brand = opens ? 'ReadableStream' : brandOf(body)

  const merged = headersOf(await resolveHeaders(options.headers))
  const own = headersOf(headers)

  // A Blob that knows its type goes under it: the client's content type is a default for a body that has none, and
  // only the call itself may name another.
  if ((brand === 'Blob' || brand === 'File') && (body as Blob).type !== '' && !own.has('content-type')) {
    merged.delete('content-type')
  }

  for (const [key, value] of own) {
    merged.set(key, value)
  }

  // A body the platform already knows how to send is passed through untouched, so an upload keeps its own
  // content type and its own encoding. Everything else is JSON.
  let payload: RawBody | undefined
  if (body !== undefined && body !== null && !opens) {
    if (isRawBody(body, brand)) {
      payload = body
    } else {
      payload = JSON.stringify(body)
      if (!merged.has('content-type')) {
        merged.set('content-type', 'application/json')
      }
    }
  }

  // The platform writes the content type of a form it encodes, a multipart boundary included, so one set by hand
  // could only replace it with something the server cannot read.
  if (brand === 'FormData' || brand === 'URLSearchParams') {
    merged.delete('content-type')
  }

  const {
    headers: _clientHeaders,
    fetch: fetchImpl,
    interceptors = [],
    authenticator,
    maxFollowUps = MAX_FOLLOW_UPS,
    ...clientRest
  } = options

  // `duplex` is not in the DOM lib's `RequestInit`, so the init is typed with it rather than passed as a literal.
  const request: RequestInit & { duplex?: 'half' } = { ...clientRest, ...rest, method, headers: merged }

  // A stream is sent as it is read, which fetch does only for a request it is told is half duplex.
  if (brand === 'ReadableStream') {
    request.duplex = 'half'
  }

  // The body of one send: a function opens its stream anew, and anything else is extracted again from what the call
  // gave, so a follow-up never needs a copy held in memory.
  const bodyOf = (): RequestInit['body'] =>
    opens ? opened(body as Opener, request.signal) : (payload as RequestInit['body'])

  const transport = fetchImpl ?? globalThis.fetch

  if (interceptors.length === 0 && authenticator === undefined) {
    return transport(url, { ...request, body: bodyOf() })
  }

  // Each call builds its own `Request`, so what an interceptor sets on one never reaches another.
  const first = new Request(url, { ...request, body: bodyOf() })
  const deliver = (sent: Request) => transport(sent)

  if (authenticator === undefined) {
    return untilAborted(intercept(interceptors, deliver)(first), request.signal)
  }

  // A stream passed as the body was read as it was sent, so no copy can carry it.
  const oneShot = brand === 'ReadableStream' && !opens

  const answering: Answering = {
    authenticator,
    limit: maxFollowUps,
    signal: request.signal,
    oneShot,
    copy(sent, sentHeaders) {
      if (oneShot) {
        return new Request(url, { ...request, headers: sentHeaders })
      }

      // A form encoded anew is written under a boundary of its own, which the platform names only when no type is set.
      if (brand === 'FormData') {
        sentHeaders.delete('content-type')
      }

      // Built on `sent` rather than cloned: a clone would hold the body in memory and drop what the platform keeps on
      // the request beside the standard fields, such as Node's dispatcher.
      const again: RequestInit & { duplex?: 'half' } = { headers: sentHeaders, body: bodyOf(), duplex: request.duplex }

      return new Request(sent, again)
    },
  }

  return untilAborted(authenticate(first, interceptors, deliver, answering), request.signal)
}

// The call as its caller sees it: rejected with the signal's reason the moment it aborts, whatever an interceptor still
// waits on. What is left winds down on the same signal: a response it still resolves with is cancelled, and a failure
// it still rejects with is nobody's to handle.
function untilAborted(call: Promise<Response>, signal: AbortSignal | null | undefined): Promise<Response> {
  if (signal === null || signal === undefined) {
    return call
  }

  return new Promise<Response>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason)
      call.then(
        response => discard(response),
        () => undefined,
      )
    }

    if (signal.aborted) {
      abort()
      return
    }

    signal.addEventListener('abort', abort, { once: true })
    call.then(
      response => {
        signal.removeEventListener('abort', abort)
        resolve(response)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** A body given as a function: what it returns is the stream to send. */
type Opener = () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>

// A stream that calls `open` on its first read, not before: a request built and never sent opens nothing. A high-water
// mark of 0 keeps the stream from pulling ahead of its reader. Once open, the call's signal cancels what it opened:
// Node's fetch stops reading a request body it aborts without cancelling it, which would leave a file or a socket open.
function opened(open: Opener, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const release = (): void => {
    reader?.cancel(signal?.reason).catch(() => undefined)
  }
  const settle = (): void => signal?.removeEventListener('abort', release)

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (reader === undefined) {
            reader = (await open()).getReader()
            signal?.addEventListener('abort', release, { once: true })
            if (signal?.aborted) {
              release()
            }
          }

          const { done, value } = await reader.read()
          if (done) {
            settle()
            controller.close()
          } else {
            controller.enqueue(value)
          }
        } catch (error) {
          settle()
          throw error
        }
      },
      cancel: reason => {
        settle()
        return reader?.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

function resolveHeaders(headers: BrewOptions['headers']): HeaderValues | Promise<HeaderValues> | undefined {
  return typeof headers === 'function' ? headers() : headers
}

/** Headers from any shape a client or a call gives them in, a name given no value left out, as the query does. */
function headersOf(values: HeaderValues | undefined): Headers {
  // Pairs, whoever made them: a `Headers` from another realm or library is not `instanceof Headers`, but iterates.
  if (values === undefined || Symbol.iterator in values) {
    return new Headers(values)
  }

  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      headers.append(name, value)
    }
  }

  return headers
}

function isRawBody(body: unknown, brand: string): body is RawBody {
  return typeof body === 'string' || ArrayBuffer.isView(body) || RAW_BODIES.has(brand)
}

// What a value is by the brand it carries, not the class it came from: `instanceof` knows only this realm's classes,
// and a body made in an iframe, or in a window this one opened, would fail it and go as JSON.
function brandOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1)
}
