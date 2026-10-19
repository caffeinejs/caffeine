import { Blob } from 'node:buffer'

import { errorCodes } from 'fastify'

import type { IContext } from '../../context.js'
import { MediaType } from '../../media.js'
import { Responder } from '../../response.js'

/** The part of a reply {@link payloadOf} writes to, so a reply of any server parameterization fits. */
export interface PayloadReply {
  code(statusCode: number): unknown
  header(name: string, value: string): unknown
  hasHeader(name: string): boolean
  type(contentType: string): unknown
}

/** The reply {@link answer} sends an empty answer on, and hands back for the server to wait on. */
export interface AnswerReply extends PayloadReply {
  send(): unknown
}

/**
 * What the adapter hands Fastify for what a route's handler or a catch handler answered with: a `Responder`'s own
 * answer in its place, shaped by {@link payloadOf}. The reply itself once `sent` says the request was answered
 * through the context, so the server waits on that send rather than starting another, and once the empty answer
 * of an answer with no body is on its way.
 *
 * An answer given later — a `Responder`'s promise, or any other thenable — is handled the same once it settles,
 * `sent` asked again then: a `Responder` may have answered through the context meanwhile.
 */
export function answer(reply: AnswerReply, ctx: IContext, result: unknown, sent: () => boolean): unknown {
  const value = result instanceof Responder ? result.respond(ctx) : result

  // The reply is a thenable too: handed back, the server waits on it, which is what it is for.
  if (value !== reply && typeof (value as PromiseLike<unknown> | null)?.then === 'function') {
    return Promise.resolve(value).then(settled => settle(reply, settled, sent))
  }

  return settle(reply, value, sent)
}

function settle(reply: AnswerReply, value: unknown, sent: () => boolean): unknown {
  if (sent()) {
    return reply
  }

  const payload = payloadOf(reply, value)

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
export function payloadOf(reply: PayloadReply, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }

  // The common answer, a plain object or an array, is JSON: nothing below could match it.
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype === Object.prototype || prototype === Array.prototype || prototype === null) {
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
