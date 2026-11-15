import type { EventEmitter } from 'node:events'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Http2ServerResponse, type Http2ServerRequest } from 'node:http2'
import { pipeline, Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { TLSSocket } from 'node:tls'

import type { Logger } from '@caffeinejs/application/logger'
import type { ByteSize } from '@caffeinejs/std/bytes'

import type { IContextPlatform } from '../../adapter.js'
import { ErrHTTPBadRequest, ErrHTTPServiceUnavailable } from '../../core/error/http.js'
import { isThenable } from '../../core/lifecycle/lifecycle.js'
import { ErrNextCalledTwice } from '../../core/middleware/errors.js'
import type { Next, NodeMiddleware } from '../../core/middleware/middleware.js'
import { contentTooLarge, declaredOver, ErrRequestBodyConsumed } from '../../core/server/body.js'
import type { NodeMiddlewareStamp, ServerPlatform } from '../../core/server/platform.js'
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

/** What the platform keeps for a request that declares a body: the keep-alive it closed, and the bytes it read. */
interface BodyState {
  /** Set where the platform closed the connection until the body is read: what to restore. */
  readonly keepAlive?: boolean
  bytes?: Uint8Array
  /** Why the route's read failed part-way: what `ctx.req.raw` refuses its body with, rather than serve what is left. */
  failure?: Error
}

const bodies = new WeakMap<NodeResponse, BodyState>()

/** The Node platform of one server: `logger` hears of a streamed answer whose source failed. */
export function createNodePlatform(logger: Logger): NodePlatform {
  const platform: NodePlatform = {
    name: 'node',
    method: res => res.req.method!,
    target: res => res.req.url!,
    protocol: res => (socketField(res, 'encrypted') === true ? 'https' : 'http'),
    header: headerOf,
    headers: res => res.req.headers as Record<string, string>,
    request: (res, limit) => requestOf(res, platform.protocol(res), signalOf(res), limit),
    hasBody: res => declaresBody(res.req),
    bodyConsumed: res => consumed(res.req),
    readBody,
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
    runNodeMiddleware,
  }

  return platform
}

/**
 * Runs a Node middleware on the request with `url` as `req.url`, stamped with what a Node framework's middleware reads.
 * The end is told as `signalOf` tells it, by `close`: `finish` is not reported for an in-process response before it
 * closes, and is reported for an HTTP/2 stream the client cancelled.
 */
function runNodeMiddleware(
  res: NodeResponse,
  fn: NodeMiddleware,
  url: string,
  stamp: NodeMiddlewareStamp,
  next: Next,
  answered: () => void,
): void {
  const req = res.req as IncomingMessage & Record<string, unknown>
  const own = req.url

  // Kept when already set: the first middleware saw the URL as received.
  req.originalUrl ??= own
  req.id = stamp.id
  req.hostname = stamp.hostname
  req.protocol = stamp.protocol
  req.ip = stamp.ip
  req.query = stamp.query

  // The answer has already left, as at `onResponse`: nothing the middleware does can answer the request. It runs, and
  // the chain goes on once it returns, whatever it does with its own `next`.
  if (res.writableEnded || destroyed(res)) {
    req.url = url
    try {
      fn(req, res as ServerResponse, () => undefined)
    } finally {
      req.url = own
    }
    next()
    return
  }

  let called = false
  let ended = false

  const onClose = (): void => {
    if (!called) {
      ended = true
      answered()
    }
  }

  // The middleware is done with the request: its URL back, and its end no longer the middleware's answer.
  const release = (): void => {
    called = true
    req.url = own
    ;(res as EventEmitter).off('close', onClose)
  }

  onceClose(res, onClose)
  req.url = url

  try {
    fn(req, res as ServerResponse, err => {
      if (called) {
        throw new ErrNextCalledTwice()
      }

      release()

      // An answer the middleware wrote stands, whatever it then hands on: the rest of the chain must not run over it.
      if (!ended && (res.writableEnded || destroyed(res))) {
        ended = true
        answered()
      } else if (!ended) {
        next(err)
      }
    })
  } catch (err) {
    if (!called) {
      release()
    }
    throw err
  }
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

  // A body nobody reads to its end would stay on a kept-alive connection: closed until the body has been read whole,
  // whatever answers first (a 413, a 415, a guard's 401, a Node middleware, a failure).
  if (declaresBody(res.req)) {
    if (res instanceof Http2ServerResponse) {
      bodies.set(res, {})
    } else {
      bodies.set(res, { keepAlive: res.shouldKeepAlive })
      res.shouldKeepAlive = false
    }
  }

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
function requestOf(res: NodeResponse, protocol: string, signal: AbortSignal, limit: ByteSize): Request {
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
    init.body = lazyBody(res, limit)
    init.duplex = 'half'
  }

  return new Request(url, init)
}

/**
 * The request body as a web stream that reads from `incoming` only once it is read, so building the `Request` takes no
 * byte from it. Once {@link readBody} has read the body, it serves those bytes instead. It fails with a 413 when the
 * body declares or brings more than `limit` bytes; `incoming` is left as it is, its connection closed after the answer.
 */
function lazyBody(res: NodeResponse, limit: ByteSize): ReadableStream<Uint8Array> {
  const incoming = res.req
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let received = 0

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (reader === undefined) {
          const state = bodies.get(res)
          if (state?.bytes !== undefined) {
            if (state.bytes.byteLength > 0) {
              controller.enqueue(state.bytes)
            }
            controller.close()
            return
          }

          // A body the route failed to read, or something else started reading: what is left is not the body.
          if (state?.failure !== undefined) {
            controller.error(state.failure)
            return
          }
          if (consumed(incoming)) {
            controller.error(new ErrRequestBodyConsumed(`${incoming.method ?? 'GET'} ${pathOf(incoming.url)}`))
            return
          }

          if (declaredOver(headerOf(res, 'content-length'), limit)) {
            controller.error(contentTooLarge(limit))
            return
          }
          reader = (Readable.toWeb(incoming as Readable) as ReadableStream<Uint8Array>).getReader()
        }

        const { done, value } = await reader.read()

        if (done) {
          restoreKeepAlive(res)
          controller.close()
          return
        }

        received += value.byteLength
        if (received > limit) {
          controller.error(contentTooLarge(limit))
          return
        }

        controller.enqueue(value)
      },
      cancel: reason => reader?.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

/**
 * Reads the body whole, as Fastify's `rawBody` does: counted as it arrives, and held to its `Content-Length`. The bytes
 * are kept for `ctx.req.raw`.
 */
function readBody(res: NodeResponse, limit: ByteSize): Promise<Uint8Array> {
  const incoming = res.req
  const declared = headerOf(res, 'content-length')

  // The client left before its body arrived: no event will come.
  if (incoming.destroyed) {
    return Promise.reject(new ErrHTTPBadRequest('The request body was cut short'))
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0

    // Kept for `ctx.req.raw`, which must not serve the rest of a body as if it were whole.
    const fail = (err: Error): void => {
      const state = bodies.get(res)
      if (state === undefined) {
        bodies.set(res, { failure: err })
      } else {
        state.failure = err
      }
      reject(err)
    }

    const settle = (): void => {
      incoming.off('data', onData)
      incoming.off('end', onEnd)
      incoming.off('error', onCut)
      incoming.off('close', onCut)
    }

    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      received += bytes.byteLength

      if (received > limit) {
        settle()
        incoming.pause()
        fail(contentTooLarge(limit))
        return
      }

      chunks.push(bytes)
    }

    const onEnd = (): void => {
      settle()

      const length = Number(declared)
      if (declared !== undefined && !Number.isNaN(length) && length !== received) {
        fail(new ErrHTTPBadRequest('The request body does not match its Content-Length'))
        return
      }

      const bytes = Buffer.concat(chunks, received)
      const state = bodies.get(res)
      // Kept for `ctx.req.raw` whether or not the request declared its body: HTTP/2 sends one without a length.
      if (state === undefined) {
        bodies.set(res, { bytes })
      } else {
        state.bytes = bytes
        restoreKeepAlive(res)
      }
      resolve(bytes)
    }

    const onCut = (): void => {
      settle()
      fail(new ErrHTTPBadRequest('The request body was cut short'))
    }

    incoming.on('data', onData)
    incoming.on('end', onEnd)
    incoming.on('error', onCut)
    incoming.on('close', onCut)
  })
}

// The path of a request target, its query left out: what an error names the request by.
function pathOf(target: string | undefined): string {
  const path = target ?? '/'
  const query = path.indexOf('?')
  return query === -1 ? path : path.slice(0, query)
}

/** Whether a request declares a body: a `Transfer-Encoding`, or a `Content-Length` other than `0`. */
function declaresBody(incoming: IncomingMessage | Http2ServerRequest): boolean {
  const { 'transfer-encoding': encoding, 'content-length': length } = incoming.headers
  return encoding !== undefined || (length !== undefined && length !== '0')
}

/** Whether something read, or started reading, the body: even one chunk, then `pause()`. A client gone is not one. */
function consumed(incoming: IncomingMessage | Http2ServerRequest): boolean {
  return incoming.readableDidRead || incoming.readableFlowing !== null || incoming.readableEnded
}

// The body has been read whole: the connection may be kept as Node would have kept it.
function restoreKeepAlive(res: NodeResponse): void {
  const state = bodies.get(res)
  if (state?.keepAlive !== undefined && !(res instanceof Http2ServerResponse)) {
    res.shouldKeepAlive = state.keepAlive
  }
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
