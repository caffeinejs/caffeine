import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'

import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { MediaType } from '../../media.js'
import { Responder } from '../../response.js'
import type { VaryReply } from '../../vary.js'
import { ErrCaffeineWebApplication } from '../error/common.js'
import { withCharset } from '../error/encode.js'
import { isThenable, type SendPayload } from '../lifecycle/lifecycle.js'
import type { IRoute } from '../routing/route.js'
import type { CompiledSerializer, SchemaCompiler } from '../validation/validation.js'
import type { Context } from './context.js'
import { isHopByHop } from './header_fields.js'

// The codings `fetch` decodes, leaving `Content-Encoding` and the encoded `Content-Length` on the body it decoded:
// `zstd` only where the bundled undici, from 7.11, and zlib both decode it (Node 24, not Node 22).
const DECODED_BY_FETCH = new Set(['gzip', 'x-gzip', 'deflate', 'br', ...(fetchDecodesZstd() ? ['zstd'] : [])])

/** The headers that describe an answer's body, which an answer put in its place must not carry over. */
export const REPRESENTATION_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
  'content-range',
  'content-disposition',
  'etag',
  'last-modified',
]

/** What answer shaping writes to: the engine's Context. `header` replaces a value, except `set-cookie`, which gains one. */
export interface AnswerTarget extends VaryReply {
  status(code: number): unknown
  hasHeader(name: string): boolean
}

/** A `Response` whose body was read cannot be sent: there is nothing left to send. */
export class ErrResponseBodyConsumed extends ErrCaffeineWebApplication {
  constructor() {
    super(
      errMessage('Cannot send a Response whose body was already read')
        .solutions('Return a new Response, or clone() it before reading its body')
        .reference('@caffeinejs/http', ErrResponseBodyConsumed)
        .build(),
      'ERR_RESPONSE_BODY_CONSUMED',
    )
    this.name = 'ErrResponseBodyConsumed'
  }
}

/**
 * What a server sends for an answer, before it serializes — a handler's, a `Responder`'s, a catch handler's,
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
export function payloadOf(reply: AnswerTarget, value: unknown, keepStatus = false): unknown {
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
    return new Uint8Array(value)
  }

  if (isStream(value)) {
    defaultType(reply, MediaType.APPLICATION_OCTET_STREAM)
    return value
  }

  // Branded, as Fastify itself tells one apart, so a Response from another realm is one too.
  if (Object.prototype.toString.call(value) === '[object Response]') {
    return unwrap(reply, value as Response, keepStatus)
  }

  return value
}

/** Takes a `Response` apart onto `target` and returns its body, or `undefined` for none. Private: `payloadOf` is its only caller. */
function unwrap(target: AnswerTarget, response: Response, keepStatus: boolean): ReadableStream<Uint8Array> | undefined {
  // Refused before the reply is touched, so whatever answers instead does not inherit half of this one.
  if (response.bodyUsed) {
    throw new ErrResponseBodyConsumed()
  }

  // A Response given as an error's body is the body: the status is the error's.
  if (!keepStatus) {
    target.status(response.status)
  }

  const headers = response.headers
  const describesConnection = connectionFields(headers)
  // A body `fetch` decoded: its coding and its encoded length describe bytes this body no longer holds.
  const decoded =
    (response.type === 'basic' || response.type === 'cors') && decodedByFetch(headers.get('content-encoding'))

  // Fastify's own copy otherwise: `set-cookie` is appended, every other header replaced.
  for (const [name, value] of headers) {
    if (describesConnection(name) || (decoded && (name === 'content-encoding' || name === 'content-length'))) {
      continue
    }

    target.header(name, value)
  }

  if (response.body === null) {
    return undefined
  }

  defaultType(target, MediaType.APPLICATION_OCTET_STREAM)

  return response.body
}

/**
 * Whether a field of `headers` describes the one connection it came over, and so is never forwarded: a field RFC 9110
 * §7.6.1 names, or one the `Connection` field lists.
 */
export function connectionFields(headers: Pick<Headers, 'get'>): (name: string) => boolean {
  const connection = headers.get('connection')
  const named = connection === null ? undefined : new Set(connection.split(',').map(name => name.trim().toLowerCase()))

  return name => isHopByHop(name) || named?.has(name) === true
}

/** Whether every coding `contentEncoding` lists is one `fetch` decoded: it decodes all of them or none. */
function decodedByFetch(contentEncoding: string | null): boolean {
  if (contentEncoding === null) {
    return false
  }

  const codings = contentEncoding.split(',').map(coding => coding.trim().toLowerCase())

  return codings.every(coding => DECODED_BY_FETCH.has(coding))
}

function fetchDecodesZstd(): boolean {
  const [major = 0, minor = 0] = (globalThis.process?.versions?.undici ?? '').split('.').map(Number)

  return typeof zlib.createZstdDecompress === 'function' && (major > 7 || (major === 7 && minor >= 11))
}

/** Writes `type` unless the route, the handler or the answer already gave the target one. */
function defaultType(target: AnswerTarget, type: string): void {
  if (!target.hasHeader('content-type')) {
    target.header('content-type', type)
  }
}

/** A Node stream or a web stream: what Fastify pipes rather than serializes. */
function isStream(value: object): boolean {
  return typeof (value as { pipe?: unknown }).pipe === 'function' || isWebStream(value)
}

function isWebStream(value: object): boolean {
  return typeof (value as { getReader?: unknown }).getReader === 'function'
}

/** What a server cannot send under the content type the answer carries. Answers as a 500. */
export class ErrInvalidPayloadType extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_INVALID_PAYLOAD_TYPE')
    this.name = 'ErrInvalidPayloadType'
  }
}

const ENCODER = new TextEncoder()

/** The serializer lookup of a route that declares no response schema, and of a request no route matched. */
export const NO_SERIALIZER = (_status: number): CompiledSerializer | undefined => undefined

/**
 * The serializer each answer of `route` is written with, by status, as Fastify picks one: the exact status, then its
 * class (`2xx`, in any case), then `default`; `undefined` when none applies.
 *
 * @param context - The route in failures, e.g. `POST /pets`.
 * @throws ErrConfiguration for a response schema `compiler` cannot compile.
 */
export function compileSerializers(
  route: IRoute<Context>,
  context: string,
  compiler: SchemaCompiler,
): (status: number) => CompiledSerializer | undefined {
  const response = route.schema?.response
  if (response === undefined || Object.keys(response).length === 0) {
    return NO_SERIALIZER
  }

  const serializers = new Map<string, CompiledSerializer>()
  for (const [key, schema] of Object.entries(response)) {
    const status = key.toLowerCase()
    serializers.set(status, compiler.serializer({ schema, context: `${context} response ${status}` }))
  }

  return status =>
    serializers.get(String(status)) ?? serializers.get(`${Math.floor(status / 100)}xx`) ?? serializers.get('default')
}

/**
 * What `value` goes out as on the engine, with the headers it carries written to `ctx`: {@link payloadOf}, then the
 * rules of Fastify's `reply.send`, JSON written by the route's serializer for `status`. `null` for no body.
 *
 * @throws ErrInvalidPayloadType for a value that is not text, bytes or a stream under a type that is not JSON.
 * @throws ErrResponseBodyConsumed for a `Response` whose body was read.
 */
export function shapeAnswer(
  ctx: Context,
  value: unknown,
  keepStatus: boolean,
  status: number,
): SendPayload | HeldStream {
  return serialize(ctx, payloadOf(ctx, value, keepStatus), status)
}

/**
 * Answers `ctx` with what a handler or a catch handler returned, unless `ctx` was answered already. A `Responder` is
 * unwrapped once; a thenable is waited on.
 */
export function answer(ctx: Context, result: unknown, unwrapped = false): void | Promise<void> {
  // Waited on even once `ctx` has answered, so a handler that answered and then failed is seen failing.
  if (isThenable(result)) {
    return Promise.resolve(result).then(settled => answer(ctx, settled, unwrapped))
  }

  if (ctx.sent) {
    return
  }

  if (!unwrapped && result instanceof Responder) {
    return answer(ctx, result.respond(ctx as unknown as IContext), true)
  }

  ctx.body(result)
}

/**
 * A Node stream answer kept as the handler returned it, so a platform that pipes Node streams sends it as it is. What
 * reads the payload through the context, an `onSend` hook among them, gets it as web bytes instead.
 */
export class HeldStream {
  #bytes?: ReadableStream<Uint8Array>
  #read = false

  constructor(readonly source: object) {}

  /**
   * The stream as web bytes, built once. Nothing is read from the source until something reads them, so a hook handed
   * them that leaves them alone leaves the platform free to pipe the source as it is.
   */
  bytes(ctx: Context): ReadableStream<Uint8Array> {
    if (this.#bytes === undefined) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const open = (): ReadableStreamDefaultReader<Uint8Array> => {
        this.#read = true
        return (reader ??= asBytes(ctx, this.source).getReader())
      }

      this.#bytes = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const next = await open().read()
            if (next.done) {
              controller.close()
            } else {
              controller.enqueue(next.value)
            }
          },
          cancel: reason => open().cancel(reason),
        },
        // Pulled only when read: what makes `untouched` hold for bytes nobody read.
        { highWaterMark: 0 },
      )
    }

    return this.#bytes
  }

  /** Whether `payload` is this stream's {@link bytes} and nothing has read, locked or cancelled them. */
  untouched(payload: unknown): boolean {
    const bytes = this.#bytes
    return bytes !== undefined && payload === bytes && !this.#read && !bytes.locked
  }
}

// What Fastify's `reply.send` does with what `payloadOf` hands it.
function serialize(ctx: Context, payload: unknown, status: number): SendPayload | HeldStream {
  if (payload === undefined) {
    return null
  }

  const type = ctx.getHeader('content-type')
  const json = type === undefined || type.includes('json')

  if (typeof payload === 'string') {
    if (type === undefined) {
      ctx.header('content-type', 'text/plain; charset=utf-8')
    } else if (json) {
      ctx.header('content-type', withCharset(type))
    }

    return payload
  }

  if (ArrayBuffer.isView(payload)) {
    defaultType(ctx, MediaType.APPLICATION_OCTET_STREAM)
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }

  if (typeof payload === 'object' && payload !== null && isStream(payload)) {
    return isWebStream(payload) ? asBytes(ctx, payload) : new HeldStream(payload)
  }

  // An empty body under a type that is not JSON, as Fastify sends it.
  if (payload === null && !json) {
    return null
  }

  if (!json) {
    throw new ErrInvalidPayloadType(
      errMessage(
        `Cannot send ${typeof payload} as "${type}": only text, bytes or a stream go out under a type that is not JSON`,
      )
        .solutions('Return a string or bytes, or set a JSON content type')
        .reference('@caffeinejs/http', ErrInvalidPayloadType)
        .build(),
    )
  }

  ctx.header('content-type', type === undefined ? 'application/json; charset=utf-8' : withCharset(type))

  const write = ctx.serializerFor(status)
  return write === undefined ? JSON.stringify(payload) : write(payload)
}

/**
 * A Node or web stream as a stream of bytes. A `Response` reads only `Uint8Array` chunks, and `Readable.from(['a'])`
 * yields strings, which Fastify pipes as they are.
 */
export function asBytes(ctx: Context, stream: object): ReadableStream<Uint8Array> {
  // A Node stream through `Readable.toWeb`, whose cancel destroys it: `ReadableStream.from` would leave one nothing has
  // read yet open, with what is behind it, a file or a socket.
  const source = isWebStream(stream)
    ? (stream as ReadableStream<unknown>)
    : stream instanceof Readable
      ? (Readable.toWeb(stream) as ReadableStream<unknown>)
      : ReadableStream.from(stream as AsyncIterable<unknown>)

  return source.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(chunk, controller) {
        if (typeof chunk === 'string') {
          controller.enqueue(ENCODER.encode(chunk))
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk)
        } else {
          const err = new ErrInvalidPayloadType(
            errMessage(`Cannot send a stream chunk of type ${typeof chunk}: a stream sends text or bytes`)
              .solutions('Enqueue strings or Uint8Array chunks')
              .reference('@caffeinejs/http', ErrInvalidPayloadType)
              .build(),
          )
          // The head has left already: the log is all that tells why the body was cut.
          ctx.logger.error({ reqId: ctx.req.id, err }, err.message)
          controller.error(err)
        }
      },
    }),
  )
}
