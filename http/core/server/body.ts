import { formatBytes, MiB, type ByteSize } from '@caffeinejs/std/bytes'
import { errMessage } from '@caffeinejs/std/err'
import sjson from 'secure-json-parse'

import { ErrCaffeineWebApplication } from '../error/common.js'
import { ErrHTTP, ErrHTTPBadRequest, ErrHTTPContentTooLarge, ErrHTTPUnsupportedMediaType } from '../error/http.js'
import { mediaTypeEssence } from '../error/serializer.js'
import { parseQuery } from './query.js'

/** The methods whose request body is read, as Fastify reads it: never a GET, HEAD or TRACE body. */
export const BODY_METHODS: ReadonlySet<string> = new Set(['DELETE', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'QUERY'])

/** The largest body a route reads unless the server or the route says otherwise. */
export const DEFAULT_BODY_LIMIT: ByteSize = 1 * MiB

/** The media types a route parses a body of. */
export type ParsedMediaType = 'application/json' | 'text/plain' | 'application/x-www-form-urlencoded'

const PARSED: ReadonlySet<string> = new Set<ParsedMediaType>([
  'application/json',
  'text/plain',
  'application/x-www-form-urlencoded',
])

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

const EMPTY = new Uint8Array(0)
const DECODER = new TextDecoder()
// Fastify's defaults: a `__proto__` key, or a `constructor` holding `prototype`, refuses the body.
const PARSE_OPTIONS = { protoAction: 'error', constructorAction: 'error' } as const

/** A body something read before the route did: the route cannot read it again. Answers 500. */
export class ErrRequestBodyConsumed extends ErrCaffeineWebApplication {
  /**
   * @param route - The route that could not read it, e.g. `POST /pets`.
   */
  constructor(route: string) {
    super(
      errMessage(`Cannot read the request body of "${route}": something read it before the route did`)
        .solutions(
          'Read the body with ctx.req.body() or $p.body() rather than ctx.req.raw',
          'Read it yourself with @BodyAsStream or @BodyAsBuffer',
        )
        .reference('@caffeinejs/http', ErrRequestBodyConsumed)
        .build(),
      'ERR_REQUEST_BODY_CONSUMED',
    )
    this.name = 'ErrRequestBodyConsumed'
  }
}

/**
 * The read of a route that answered before reading its body, failed once the answer has gone. On the Node application
 * over HTTP/1.1, the server then reads what is left of the body and drops it, so the connection can serve the next
 * request. Nothing answers it: the route has answered already.
 */
export class ErrRequestBodyDiscarded extends ErrCaffeineWebApplication {
  /**
   * @param request - The request whose body was dropped: its method and path, e.g. `POST /pets/42`.
   */
  constructor(request: string) {
    super(
      errMessage(
        `Cannot read the request body of "${request}": the route answered before reading it, and it was dropped`,
      )
        .solutions('Read the body before answering: whole with @BodyAsBuffer() or $p.body(), or with @BodyAsStream()')
        .reference('@caffeinejs/http', ErrRequestBodyDiscarded)
        .build(),
      'ERR_REQUEST_BODY_DISCARDED',
    )
    this.name = 'ErrRequestBodyDiscarded'
  }
}

/** Whether `value` is a body limit: a whole number of bytes above 0. */
export function isBodyLimit(value: unknown): value is ByteSize {
  return Number.isSafeInteger(value) && (value as number) > 0
}

/**
 * The media type a body of `contentType` is parsed as.
 *
 * @throws ErrHTTPUnsupportedMediaType for a header that is not a media type, or one no parser reads.
 */
export function parsedMediaType(contentType: string): ParsedMediaType {
  const essence = mediaTypeEssence(contentType)

  if (!PARSED.has(essence)) {
    throw new ErrHTTPUnsupportedMediaType(`Unsupported media type "${essence}"`)
  }

  return essence as ParsedMediaType
}

/**
 * The value a whole body of `type` holds: JSON parsed, refusing a `__proto__` or `constructor.prototype` key; text as
 * it is; a form as a query string reads.
 *
 * @throws ErrHTTPBadRequest for an empty or invalid JSON body, or one holding a forbidden prototype key.
 */
export function parseBody(type: ParsedMediaType, bytes: Uint8Array): unknown {
  if (type === 'application/json' && bytes.length === 0) {
    throw new ErrHTTPBadRequest('The request body is empty, but its Content-Type is application/json')
  }

  const text = DECODER.decode(bytes)

  if (type === 'text/plain') {
    return text
  }

  if (type === 'application/x-www-form-urlencoded') {
    return parseQuery(text)
  }

  try {
    return sjson.parse(text, undefined, PARSE_OPTIONS) as unknown
  } catch {
    // The parser's message quotes the body, which a response never echoes.
    throw new ErrHTTPBadRequest('The request body is not valid JSON')
  }
}

/** The error a body larger than `limit` answers with. */
export function contentTooLarge(limit: ByteSize): ErrHTTPContentTooLarge {
  return new ErrHTTPContentTooLarge(`The request body is larger than ${formatBytes(limit)}`)
}

/** Whether a declared `Content-Length` is above `limit`. */
export function declaredOver(contentLength: string | undefined, limit: ByteSize): boolean {
  return contentLength !== undefined && Number(contentLength) > limit
}

/** Reads `stream` whole, at most `limit` bytes: past them, it cancels the stream and rejects with a 413. */
export function readLimited(stream: ReadableStream<Uint8Array> | null, limit: ByteSize): Promise<Uint8Array> {
  if (stream === null) {
    return Promise.resolve(EMPTY)
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  const step = ({ done, value }: ReadResult): Uint8Array | Promise<Uint8Array> => {
    if (done) {
      return concat(chunks, received)
    }

    received += value.byteLength
    if (received > limit) {
      return reader.cancel().then(
        () => Promise.reject(contentTooLarge(limit)),
        () => Promise.reject(contentTooLarge(limit)),
      )
    }

    chunks.push(value)
    return read()
  }
  // A stream that fails part-way is a client that left: its request, not the server, is at fault. An answer the
  // stream already carries, such as a limit's 413, stands.
  const read = (): Promise<Uint8Array> =>
    reader
      .read()
      .then(step, (err: unknown) =>
        Promise.reject(err instanceof ErrHTTP ? err : new ErrHTTPBadRequest('The request body was cut short')),
      )

  return read()
}

/** `stream`, failing with a 413 once more than `limit` bytes have passed. `null` is an empty stream. */
export function limitStream(stream: ReadableStream<Uint8Array> | null, limit: ByteSize): ReadableStream<Uint8Array> {
  if (stream === null) {
    return new ReadableStream<Uint8Array>({ start: controller => controller.close() })
  }

  let received = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > limit) {
          controller.error(contentTooLarge(limit))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0]
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
