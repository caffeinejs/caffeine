import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import type { Readable } from 'node:stream'

import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { MediaType } from '../../media.js'
import { Responder, type ActionResult } from '../../response.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPPreconditionFailed } from '../error/http.js'
import { notModified, preconditionFailed, rangeHolds } from './_conditional.js'
import { contentDisposition } from './_disposition.js'
import { byteRanges, multipartByteRanges } from './_range.js'

// The largest end offset Node's `Blob.slice` takes: it asserts a 32-bit one, aborting the process past it.
const LARGEST_SLICEABLE = 2 ** 32 - 1

// RFC 9110 §8.8.3: an optional weak prefix, then a quoted string holding neither a space nor a quote.
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/

/** {@link Attachment}'s options. */
export interface AttachmentOptions {
  /**
   * The name the client saves the download under. A `File`'s own name when not given. Either is reduced to a plain
   * file name: its last `/` or `\` segment, without control characters or the marks that reorder how it reads.
   */
  name?: string
  /**
   * The `Content-Type`, over the route's. Without it, the route's or the handler's type, then a `Blob`'s own, then
   * `application/octet-stream`. Several ranges go out as `multipart/byteranges`, each part under this type.
   */
  type?: string
  /**
   * A strong entity tag for the content, quoted (`'"v42"'`), written as `ETag` and compared with `If-Match`,
   * `If-None-Match` and `If-Range`. A weak one (`W/"v42"`) still answers `If-None-Match`, but never satisfies
   * `If-Match` nor resumes a download: it does not promise the bytes are the same.
   */
  etag?: string
  /**
   * When the content last changed, written as `Last-Modified` and compared with `If-Unmodified-Since`,
   * `If-Modified-Since` and `If-Range` to the second.
   */
  lastModified?: Date
}

/** What {@link Attachment} sends: bytes whose length is known, or a stream. */
export type AttachmentBody = Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer> | ReadableStream<Uint8Array> | Readable

/**
 * Sends `body` as a download, named for the client and, when its length is known, served in ranges, so a large one
 * cut off part-way resumes instead of starting over.
 *
 * `Content-Disposition` carries the name twice, as a plain `filename` and as RFC 8187 UTF-8 in `filename*`, so a
 * name outside ASCII reaches every client intact.
 *
 * A `Blob` or bytes answer a `GET` carrying `Range` with `206` and that range, and say `Accept-Ranges: bytes`. Several
 * ranges go out together as `multipart/byteranges`, in the order asked for; a range starting past the end is left out,
 * and `416` answers when none is left. A malformed range, another unit, more than 100 ranges, or ranges adding up to
 * more than the body get the whole body. With `If-Range`, ranges are served only while the client's validator still
 * matches `etag` or `lastModified`; otherwise the whole current body goes out. A stream is sent whole, its length not
 * known, and so is a `Blob` past 4 GiB, which Node cannot cut a part out of.
 *
 * Preconditions come first, in RFC 9110's order. A `GET` or a `HEAD` whose `If-Match` lists no tag strongly matching
 * `etag`, or, sent without `If-Match`, whose `If-Unmodified-Since` is before `lastModified`, is refused: an
 * {@link ErrHTTPPreconditionFailed} is thrown, which error handling answers with `412`, a `@Catch` handler included.
 * One from a client that holds the content already is answered `304` with no body: its `If-None-Match` lists `etag`,
 * compared weakly, or is `*`; or, sent without `If-None-Match`, its `If-Modified-Since` is not before `lastModified`.
 * A stream either answer leaves unread is closed.
 *
 * Ranges, the `304` and the `412` answer in place of a `200` only: a status the route or the handler set is kept,
 * with the whole body, and any other method is the handler's own to guard, having acted already.
 *
 * @throws {@link ErrConfiguration} for an `etag` that is not a quoted entity tag, or a `lastModified` that is not a
 * valid date: either would be written as a validator no client can match.
 * @example
 * ```ts
 * .get('/exports/q3').handler(async () =>
 *   Attachment(await report.csv(), { name: 'relatório Q3.csv', type: 'text/csv', etag: `"${report.version}"` }),
 * )
 * ```
 */
export function Attachment(body: AttachmentBody, options: AttachmentOptions = {}): Responder {
  const { etag, lastModified } = options

  if (etag !== undefined && !ENTITY_TAG.test(etag)) {
    const bare = etag.replace(/^W\//i, '').replaceAll('"', '')

    throw new ErrConfiguration(
      errMessage(`Cannot use "${etag}" as an ETag: an entity tag is quoted and holds no space or quote of its own`)
        .solutions(
          String.raw`Write it as "\"${bare}\""`,
          String.raw`Write it as "W/\"${bare}\"" for a weak tag, which resumes no download`,
        )
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  if (lastModified !== undefined && Number.isNaN(lastModified.getTime())) {
    throw new ErrConfiguration(
      errMessage('Cannot use an invalid Date as lastModified: it holds no time to write as Last-Modified')
        .solutions('Pass the time the content last changed, as a valid Date')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return new AttachmentResult(body, options)
}

class AttachmentResult extends Responder {
  constructor(
    readonly body: AttachmentBody,
    readonly options: AttachmentOptions,
  ) {
    super()
  }

  respond(ctx: IContext): ActionResult {
    const { body, options } = this

    if (options.etag !== undefined) {
      ctx.header('etag', options.etag)
    }

    if (options.lastModified !== undefined) {
      ctx.header('last-modified', options.lastModified.toUTCString())
    }

    // RFC 9110 §13.2.2: preconditions in its order, before ranges, and only where the answer would be a 200 to a GET
    // or a HEAD; on any other method the handler has acted already, and a refusal now would say it had not. A 412
    // goes through error handling, as any refusal does; a 304 carries the validators and nothing that describes a body.
    const method = ctx.req.method
    if ((method === 'GET' || method === 'HEAD') && ctx.statusCode === 200) {
      if (preconditionFailed(ctx.req.header('if-match'), ctx.req.header('if-unmodified-since'), options)) {
        discard(body)
        throw new ErrHTTPPreconditionFailed()
      }

      if (notModified(ctx.req.header('if-none-match'), ctx.req.header('if-modified-since'), options)) {
        discard(body)
        ctx.status(304)
        return undefined
      }
    }

    ctx.header(
      'content-disposition',
      contentDisposition(options.name ?? (body instanceof NodeFile ? body.name : undefined)),
    )

    if (options.type !== undefined) {
      ctx.header('content-type', options.type)
    }

    const sized = sizedOf(body)
    if (sized === undefined) {
      return body
    }

    const size = sized instanceof NodeBlob ? sized.size : sized.byteLength
    ctx.header('accept-ranges', 'bytes')

    // Ranges are a GET's, served in place of a 200: a HEAD is answered as the whole GET would be, and a status the
    // route or the handler set is kept.
    const header = ctx.req.header('range')
    const ranged =
      header !== undefined &&
      method === 'GET' &&
      ctx.statusCode === 200 &&
      rangeHolds(ctx.req.header('if-range'), options)
    const ranges = ranged ? byteRanges(header, size) : undefined

    if (ranges === undefined) {
      return body
    }

    if (ranges === 'unsatisfiable') {
      ctx.status(416).header('content-range', `bytes */${size}`)
      return undefined
    }

    // RFC 9110 §15.3.7.2: one range goes out as itself, never as a multipart body of one part.
    if (ranges.length === 1) {
      const [[start, end]] = ranges
      ctx.status(206).header('content-range', `bytes ${start}-${end}/${size}`)

      // Bytes are not copied for a part of them: Fastify sends the view as it is.
      return sized instanceof NodeBlob ? sized.slice(start, end + 1, sized.type) : sized.subarray(start, end + 1)
    }

    // Each part carries the type the whole body would go out under. A fresh boundary per answer, drawn at random,
    // is one no body can be made to hold.
    const type =
      ctx.getHeader('content-type') ??
      (sized instanceof NodeBlob && sized.type !== '' ? sized.type : MediaType.APPLICATION_OCTET_STREAM)
    const boundary = crypto.randomUUID().replaceAll('-', '')
    ctx.status(206).header('content-type', `multipart/byteranges; boundary=${boundary}`)

    return multipartByteRanges(sized, ranges, type, boundary)
  }
}

/** Closes a stream a 304 or a 412 leaves unread, so a file behind it is closed too. */
function discard(body: AttachmentBody): void {
  if (body instanceof ReadableStream) {
    // A stream that fails as it closes has nobody left to tell.
    body.cancel().catch(() => undefined)
  } else if ('destroy' in body) {
    body.destroy()
  }
}

/**
 * The body as something with a length to take ranges of, or `undefined` for one to send whole: a stream, or a Blob
 * past 4 GiB, which Node cannot cut a part out of: its `slice` takes 32-bit offsets and aborts the process past
 * them.
 */
function sizedOf(body: AttachmentBody): NodeBlob | Uint8Array<ArrayBuffer> | undefined {
  if (body instanceof NodeBlob) {
    return body.size <= LARGEST_SLICEABLE ? body : undefined
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body)
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }

  return undefined
}
