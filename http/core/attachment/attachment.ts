import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import type { Readable } from 'node:stream'

import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import { Responder, type ActionResult } from '../../response.js'
import { ErrConfiguration } from '../error/common.js'
import { contentDisposition } from './_disposition.js'
import { byteRange } from './_range.js'

// The largest end offset Node's `Blob.slice` takes: it asserts a 32-bit one, aborting the process past it.
const LARGEST_SLICEABLE = 2 ** 32 - 1

// RFC 9110 §8.8.3: an optional weak prefix, then a quoted string holding neither a space nor a quote.
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/

/** {@link Attachment}'s options. */
export interface AttachmentOptions {
  /** The name the client saves the download under. A `File`'s own name when not given. */
  name?: string
  /**
   * The `Content-Type`, over the route's. Without it, the route's or the handler's type, then a `Blob`'s own, then
   * `application/octet-stream`.
   */
  type?: string
  /**
   * A strong entity tag for the content, quoted (`'"v42"'`), written as `ETag` and compared with `If-Range`. A weak
   * one (`W/"v42"`) is written but never resumes a download: it does not promise the bytes are the same.
   */
  etag?: string
  /** When the content last changed, written as `Last-Modified` and compared with `If-Range` to the second. */
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
 * A range answers a `200` only: a status the route or the handler set is kept, with the whole body.
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
          `Write it as "\\"${bare}\\""`,
          `Write it as "W/\\"${bare}\\"" for a weak tag, which resumes no download`,
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

    ctx.header(
      'content-disposition',
      contentDisposition(options.name ?? (body instanceof NodeFile ? body.name : undefined)),
    )

    if (options.type !== undefined) {
      ctx.header('content-type', options.type)
    }

    if (options.etag !== undefined) {
      ctx.header('etag', options.etag)
    }

    if (options.lastModified !== undefined) {
      ctx.header('last-modified', options.lastModified.toUTCString())
    }

    const sized = sizedOf(body)
    if (sized === undefined) {
      return body
    }

    const size = sized instanceof NodeBlob ? sized.size : sized.byteLength
    ctx.header('accept-ranges', 'bytes')

    // Ranges are a GET's, served in place of a 200: a HEAD is answered as the whole GET would be, and a status the
    // route or the handler set is kept.
    const ranged = ctx.req.method === 'GET' && ctx.statusCode === 200 && matches(ctx.req.header('if-range'), options)
    const range = ranged ? byteRange(ctx.req.header('range'), size) : undefined

    if (range === undefined) {
      return body
    }

    if (range === 'unsatisfiable') {
      ctx.status(416).header('content-range', `bytes */${size}`)
      return undefined
    }

    const [start, end] = range
    ctx.status(206).header('content-range', `bytes ${start}-${end}/${size}`)

    // A part goes out as a stream either way, so a cache in front, which hashes and keeps bytes, never takes it for
    // the whole. Bytes are not copied for it: the one chunk is a view of the same memory.
    if (sized instanceof NodeBlob) {
      return sized.slice(start, end + 1, sized.type)
    }

    ctx.header('content-length', String(end - start + 1))
    return chunk(sized.subarray(start, end + 1))
  }
}

/** `bytes` as a stream of one chunk. */
function chunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * The body as something with a length to take ranges of, or `undefined` for one to send whole: a stream, or a Blob
 * past 4 GiB, which Node cannot cut a part out of — its `slice` takes 32-bit offsets and aborts the process past them.
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
    return options.etag !== undefined && !options.etag.startsWith('W/') && ifRange === options.etag
  }

  if (options.lastModified === undefined) {
    return false
  }

  const date = Date.parse(ifRange)

  return !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(options.lastModified.getTime() / 1000)
}
