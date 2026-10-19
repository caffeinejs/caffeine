import { Blob } from 'node:buffer'

import { errorCodes } from 'fastify'

import { MediaType } from '../../media.js'
import { Responder } from '../../response.js'
import type { Context } from './context.js'

/** The part of a reply this module writes to, so a reply of any server parameterization fits. */
interface Reply {
  code(statusCode: number): unknown
  header(name: string, value: string): unknown
  hasHeader(name: string): boolean
  type(contentType: string): unknown
  send(): unknown
}

/**
 * Whether the request is answered already, so nothing more is sent: through the context, or by Fastify's own 503 for
 * a handler that outlived its timeout. Built once per route or error handler, never per request.
 */
type Answered = (ctx: Context) => boolean

/**
 * What the adapter hands Fastify for what a route's handler or a catch handler answered with: the answer a
 * `Responder` gives in its place, unwrapped once, and an answer given later once it settles, shaped by
 * {@link payloadOf}.
 *
 * The reply itself once `answered`, which is asked before anything runs and again after every wait, so the server
 * waits on the send in flight instead of starting a second over it; and the reply once the empty answer of an answer
 * with no body is on its way.
 */
export function answer(reply: Reply, ctx: Context, result: unknown, answered: Answered, unwrapped = false): unknown {
  if (answered(ctx)) {
    return reply
  }

  // The reply is a thenable too: handed back, the server waits on it, which is what it is for.
  if (result !== reply && typeof (result as PromiseLike<unknown> | null)?.then === 'function') {
    return Promise.resolve(result).then(settled => answer(reply, ctx, settled, answered, unwrapped))
  }

  if (!unwrapped && result instanceof Responder) {
    return answer(reply, ctx, result.respond(ctx), answered, true)
  }

  const payload = payloadOf(reply, result)

  if (payload === undefined) {
    reply.send()
    return reply
  }

  return payload
}

/**
 * What the adapter hands Fastify's `send` for an answer — a handler's, a `Responder`'s, a catch handler's,
 * `ctx.body(...)`'s, an `ErrHTTP`'s body: the same answer, in a shape Fastify sends as the bytes it holds, with
 * the headers the answer carries written to the reply. `undefined` when the answer has no body.
 *
 * Fastify sends a stream, a typed array and a string as they are and serializes anything else as JSON, so a
 * `Blob`, a `File` and an `ArrayBuffer` would go out as `{}`. A `Blob` is streamed rather than read into memory,
 * since one can be a file on disk. A stream is labelled as the bytes Fastify labels a typed array, unless the
 * route or the handler named a type. A `Response` is taken apart here rather than handed on: its status and
 * headers reach the reply before the `onSend` hooks run, so they see what goes out, and Fastify's HEAD route, which
 * cannot measure a `Response`, gets a body it can drop.
 */
export function payloadOf(reply: Reply, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }

  // The common answers need nothing here: a plain object or an array is JSON, and Fastify sends a view of bytes.
  const prototype: unknown = Object.getPrototypeOf(value)
  if (
    prototype === Object.prototype ||
    prototype === Array.prototype ||
    prototype === null ||
    ArrayBuffer.isView(value)
  ) {
    return value
  }

  // The global Blob, and File with it: `node:buffer` exports the same classes.
  if (value instanceof Blob) {
    defaultType(reply, value.type || MediaType.APPLICATION_OCTET_STREAM)
    reply.header('content-length', String(value.size))
    return value.stream()
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }

  if (isStream(value)) {
    defaultType(reply, MediaType.APPLICATION_OCTET_STREAM)
    return value
  }

  // Branded, as Fastify itself tells one apart, so a Response from another realm is one too.
  if (Object.prototype.toString.call(value) === '[object Response]') {
    return unwrap(reply, value as Response)
  }

  return value
}

function unwrap(reply: Reply, response: Response): unknown {
  // Refused before the reply is touched, so whatever answers instead does not inherit half of this one.
  if (response.bodyUsed) {
    throw new errorCodes.FST_ERR_REP_RESPONSE_BODY_CONSUMED()
  }

  reply.code(response.status)

  // Fastify's own copy: `set-cookie` is appended, every other header replaced.
  for (const [name, value] of response.headers) {
    reply.header(name, value)
  }

  if (response.body === null) {
    return undefined
  }

  defaultType(reply, MediaType.APPLICATION_OCTET_STREAM)

  return response.body
}

/** Writes `type` unless the route, the handler or the answer already gave the reply one. */
function defaultType(reply: Reply, type: string): void {
  if (!reply.hasHeader('content-type')) {
    reply.type(type)
  }
}

/** A Node stream or a web stream: what Fastify pipes rather than serializes. */
function isStream(value: object): boolean {
  return (
    typeof (value as { pipe?: unknown }).pipe === 'function' ||
    typeof (value as { getReader?: unknown }).getReader === 'function'
  )
}
