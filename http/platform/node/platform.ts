import type { EventEmitter } from 'node:events'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Http2ServerResponse, type Http2ServerRequest } from 'node:http2'
import { pipeline, Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { TLSSocket } from 'node:tls'

import type { Logger } from '@caffeinejs/application/logger'

import type { IContextPlatform } from '../../adapter.js'
import { ErrHTTPServiceUnavailable } from '../../core/error/http.js'
import { isThenable } from '../../core/lifecycle/lifecycle.js'
import type { ServerPlatform } from '../../core/server/platform.js'
import type { HTTPServer } from '../../core/server/server.js'

/** The response of one request a Node server received, over HTTP/1.1 or HTTP/2. */
export type NodeResponse = ServerResponse | Http2ServerResponse

/** What `ctx.platform` is on the Node application: Node's request and response. */
export interface NodeContextPlatform extends IContextPlatform {
  readonly name: 'node'
  readonly incoming: IncomingMessage | Http2ServerRequest
  readonly outgoing: NodeResponse
}

type NodePlatform = ServerPlatform<NodeResponse, NodeContextPlatform, void>

/** The Node platform of one server: `logger` hears of a streamed answer whose source failed. */
export function createNodePlatform(logger: Logger): NodePlatform {
  const platform: NodePlatform = {
    name: 'node',
    method: res => res.req.method!,
    target: res => res.req.url!,
    protocol: res => (socketField(res, 'encrypted') === true ? 'https' : 'http'),
    header: headerOf,
    headers: res => res.req.headers as Record<string, string>,
    request: res => requestOf(res, platform.protocol(res), signalOf(res)),
    signal: signalOf,
    remoteAddress: res => socketField(res, 'remoteAddress'),
    context: res => ({ name: 'node', incoming: res.req, outgoing: res }),
    respond: (res, head, payload, hooks) => {
      writeHead(res, head.status, head.headers as OutgoingHttpHeaders)

      if (payload instanceof ReadableStream) {
        hooks.cancelWith(() => destroy(res))
        // Through a Node stream, not the web stream itself: `pipeline` reads what a `drain` event carries as a
        // failure when it pumps a web stream, and an in-process response hands `drain` the size it wants.
        pipeline(Readable.fromWeb(payload as WebReadableStream<Uint8Array>), res as NodeJS.WritableStream, err => {
          // A response closed early is the client leaving, a reset HTTP/2 stream included: nothing failed here.
          if (
            err !== null &&
            err !== undefined &&
            (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE'
          ) {
            // The platform never sees the request ID, so the method and URL stand in for it.
            logger.error({ err, method: res.req.method, url: res.req.url }, 'Cannot send the streamed answer')
          }
        })

        // A stream may still read from the scope until it ends. A response already closed will not close again.
        if (destroyed(res)) {
          hooks.sent()
        } else {
          onceClose(res, hooks.sent)
        }
      } else {
        end(res, payload ?? undefined)
        // A body already whole needs nothing of its request once Node holds it, as on the fetch platform: released at
        // once, so a slow reader keeps none of its request alive.
        hooks.sent()
      }
    },
  }

  return platform
}

/**
 * Serves one Node request on `engine`. A failure that escapes the engine, which logged it, is answered 500 while the
 * head has not gone out; otherwise, and for a request a forced close cut, the response is destroyed.
 */
export function serveNode(
  engine: HTTPServer,
  platform: NodePlatform,
  res: NodeResponse,
  drainAtRespond: boolean,
): void {
  let answer: void | Promise<void>

  try {
    answer = engine.serve(platform, res, undefined, drainAtRespond)
  } catch {
    fail(res)
    return
  }

  if (isThenable(answer)) {
    // A forced close fails what it cuts with a 503 error: the response is destroyed, as its socket is, not answered.
    // An in-process caller is handed that error, as the fetch application's is.
    answer.then(undefined, (err: unknown) => {
      if (!(err instanceof ErrHTTPServiceUnavailable)) {
        fail(res)
      } else if (drainAtRespond) {
        res.destroy(err)
      } else {
        destroy(res)
      }
    })
  }
}

// Sending failed before the head went out, such as `writeHead` refusing a header value with a CR or LF: answered 500
// as Fastify answers it. Once the head is out, the response can only be cut.
function fail(res: NodeResponse): void {
  if (res.headersSent) {
    destroy(res)
    return
  }

  try {
    writeHead(res, 500, { 'content-length': '0' })
    end(res)
  } catch {
    destroy(res)
  }
}

function headerOf(res: NodeResponse, name: string): string | undefined {
  const headers = res.req.headers as Record<string, string | string[] | undefined>
  const lower = name.toLowerCase()
  let value = headers[lower]

  // HTTP/2 names the authority in its own pseudo-header.
  if (value === undefined && lower === 'host') {
    value = headers[':authority']
  }

  return Array.isArray(value) ? value.join(', ') : value
}

/**
 * The request as a web `Request`. Its URL names the host the request did, on the connection's scheme, and keeps the
 * target as a path whatever it holds. Its body reads nothing until it is read.
 */
function requestOf(res: NodeResponse, protocol: string, signal: AbortSignal): Request {
  const incoming = res.req
  const target = incoming.url ?? '/'

  // Concatenated, not resolved: a target such as "//evil.example/x" stays a path.
  const url = new URL(`${protocol}://localhost/${target.startsWith('/') ? target.slice(1) : target}`)
  const authority = headerOf(res, 'host')
  if (authority !== undefined) {
    // A value that is not a host leaves `localhost`.
    url.host = authority
  }

  const headers = new Headers()
  const raw = incoming.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!

    // HTTP/2's pseudo-headers are no header of the request.
    if (name.startsWith(':')) {
      continue
    }

    try {
      headers.append(name, raw[i + 1]!)
    } catch {
      // A value `Headers` refuses is left out rather than failing every read of `raw`.
    }
  }

  const method = incoming.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal }

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = lazyBody(incoming)
    init.duplex = 'half'
  }

  return new Request(url, init)
}

/**
 * The request body as a web stream that reads from `incoming` only once it is read, so building the `Request` takes no
 * byte from it.
 */
function lazyBody(incoming: Readable): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= (Readable.toWeb(incoming) as ReadableStream<Uint8Array>).getReader()
        const { done, value } = await reader.read()

        if (done) {
          controller.close()
        } else {
          controller.enqueue(value)
        }
      },
      cancel: reason => reader?.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

/**
 * Aborts once the client has left: the response closed before its end was written, or its connection failed. Not
 * `writableFinished` nor the `finish` event: Node reports an HTTP/2 stream the client cancelled as finished, and an
 * in-process response closes before it reports itself finished.
 */
function signalOf(res: NodeResponse): AbortSignal {
  const controller = new AbortController()
  const onClose = (): void => {
    if (!res.writableEnded || (socketField(res, 'errored') ?? null) !== null) {
      controller.abort()
    }
  }

  if (destroyed(res)) {
    onClose()
  } else {
    onceClose(res, onClose)
  }

  return controller.signal
}

// The two response classes overload their methods apart, so a union of them cannot be called: each call branches.

function writeHead(res: NodeResponse, status: number, headers: OutgoingHttpHeaders): void {
  if (res instanceof Http2ServerResponse) {
    res.writeHead(status, headers)
  } else {
    res.writeHead(status, headers)
  }
}

function end(res: NodeResponse, chunk?: string | Uint8Array): void {
  if (res instanceof Http2ServerResponse) {
    if (chunk === undefined) {
      res.end()
    } else {
      res.end(chunk)
    }
  } else if (chunk === undefined) {
    res.end()
  } else {
    res.end(chunk)
  }
}

// Both are event emitters: `once` has one signature here.
function onceClose(res: NodeResponse, fn: () => void): void {
  ;(res as EventEmitter).once('close', fn)
}

// An HTTP/2 response has no `destroyed`: its stream does.
function destroyed(res: NodeResponse): boolean {
  return res instanceof Http2ServerResponse ? res.stream.destroyed : res.destroyed
}

function destroy(res: NodeResponse): void {
  if (res instanceof Http2ServerResponse) {
    res.stream.destroy()
  } else {
    res.destroy()
  }
}

// HTTP/2's socket is a proxy that may throw once its session is gone, on the socket or on a field.
function socketField<K extends 'encrypted' | 'remoteAddress' | 'errored'>(
  res: NodeResponse,
  key: K,
): TLSSocket[K] | undefined {
  try {
    return (res.req.socket as TLSSocket)[key]
  } catch {
    return undefined
  }
}
