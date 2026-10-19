import { type Readable } from 'node:stream'

import { type IContext } from './context.js'

/**
 * What a handler, a `Responder`, an error handler or `ctx.body(...)` may answer with.
 *
 * Bytes go out as they are: a `Blob` or a `File` streamed with its size as `Content-Length`, an `ArrayBuffer` or a
 * typed array whole, a stream as it produces them. Their `Content-Type` is the route's or the handler's, else a
 * `Blob`'s own, else `application/octet-stream`. A `Response` goes out as its status, its headers and its body. Any
 * other object is serialized as JSON.
 *
 * A `File` from an upload carries the type its client claimed: answer one with `Attachment(...)`, or set its type,
 * rather than return it as it is.
 */
export type ActionResultTypes =
  | void
  | string
  | number
  | boolean
  | null
  | Buffer
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | Response
  | Readable
  | ReadableStream
  | ReadonlyArray<unknown>
  | Readonly<Record<string, unknown>>
  | object
  | Responder

export type ActionResult = ActionResultTypes | PromiseLike<ActionResultTypes>

export abstract class Responder {
  abstract respond(ctx: IContext): ActionResult
}
