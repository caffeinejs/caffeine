import { Blob } from 'node:buffer'

import { errorCodes } from 'fastify'

import { MediaType } from '../../media.js'

/** The part of a reply {@link payloadOf} writes to, so a reply of any server parameterization fits. */
export interface PayloadReply {
  code(statusCode: number): unknown
  header(name: string, value: string): unknown
  hasHeader(name: string): boolean
  type(contentType: string): unknown
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
 *
 * A `Responder` that answers later hands back a promise; its value is shaped once it settles.
 */
export function payloadOf(reply: PayloadReply, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }

  if (value instanceof Promise) {
    return value.then((settled: unknown) => payloadOf(reply, settled))
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

function unwrap(reply: PayloadReply, response: Response): unknown {
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
function defaultType(reply: PayloadReply, type: string): void {
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
