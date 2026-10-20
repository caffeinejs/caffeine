import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import type { Readable } from 'node:stream'

import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { Responder, type ActionResult } from '../../response.js'
import { ErrConfiguration } from '../error/common.js'
import { notModified } from './_conditional.js'
import { contentDisposition } from './_disposition.js'
import { byteRange } from './_range.js'

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
   * `application/octet-stream`.
   */
  type?: string
  /**
   * A strong entity tag for the content, quoted (`'"v42"'`), written as `ETag` and compared with `If-None-Match` and
   * `If-Range`. A weak one (`W/"v42"`) still answers `If-None-Match`, but never resumes a download: it does not promise
   * the bytes are the same.
   */
  etag?: string
  /**
   * When the content last changed, written as `Last-Modified` and compared with `If-Modified-Since` and `If-Range` to
   * the second.
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
 * A `Blob` or bytes answer a `GET` carrying `Range` with `206` and that range, or `416` for one past the end, and
 * say `Accept-Ranges: bytes`. Several ranges, a malformed one or another unit are answered with the whole body.
 * With `If-Range`, the range is served only while the client's validator still matches `etag` or `lastModified`;
 * otherwise the whole current body goes out. A stream is sent whole, its length not known, and so is a `Blob` past
 * 4 GiB, which Node cannot cut a part out of.
 *
 * A `GET` or a `HEAD` from a client that holds the content already is answered `304` with no body, before any range:
 * its `If-None-Match` lists `etag`, compared weakly, or is `*`; or, sent without `If-None-Match`, its
 * `If-Modified-Since` is not before `lastModified`. A stream the `304` leaves unread is closed.
 *
 * A range and a `304` answer in place of a `200` only: a status the route or the handler set is kept, with the whole
 * body.
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

    // RFC 9110 §13.2.2: preconditions before ranges, and only where the answer would be a 200 to a GET or a HEAD. A
    // 304 carries the validators and nothing that describes a body.
    const method = ctx.req.method
    if (
      (method === 'GET' || method === 'HEAD') &&
      ctx.statusCode === 200 &&
      notModified(ctx.req.header('if-none-match'), ctx.req.header('if-modified-since'), options)
    ) {
      discard(body)
      ctx.status(304)
      return undefined
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
      ctx.req.method === 'GET' &&
      ctx.statusCode === 200 &&
      matches(ctx.req.header('if-range'), options)
    const range = ranged ? byteRange(header, size) : undefined

    if (range === undefined) {
      return body
    }

    if (range === 'unsatisfiable') {
      ctx.status(416).header('content-range', `bytes */${size}`)
      return undefined
    }

    const [start, end] = range
    ctx.status(206).header('content-range', `bytes ${start}-${end}/${size}`)

    // Bytes are not copied for a part of them: Fastify sends the view as it is.
    return sized instanceof NodeBlob ? sized.slice(start, end + 1, sized.type) : sized.subarray(start, end + 1)
  }
}

/** Closes a stream a 304 leaves unread, so a file behind it is closed too. */
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

/**
 * Whether the content is still the one the client holds part of, by RFC 9110 §13.1.5: an entity tag compared
 * strongly, so a weak one never matches, or a date equal to `Last-Modified`. No `If-Range` at all matches.
 */
function matches(ifRange: string | undefined, options: AttachmentOptions): boolean {
  if (ifRange === undefined) {
    return true
  }

  if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
    return ifRange === options.etag && !ifRange.startsWith('W/')
  }

  if (options.lastModified === undefined) {
    return false
  }

  const date = Date.parse(ifRange)

  return !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(options.lastModified.getTime() / 1000)
}
