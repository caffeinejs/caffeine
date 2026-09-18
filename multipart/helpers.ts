import type { Readable } from 'node:stream'

import type { FastifyRequest } from 'fastify'

import {
  nodeStreamFile,
  nodeStreamFiles,
  nodeStreamParts,
  readFile,
  readFiles,
  readFormData,
  webStreamFile,
  webStreamFiles,
  webStreamParts,
} from './_parts.js'
import type { MultipartField, WebMultipartFile } from './multipart.js'

/**
 * What {@link multipart} needs from a context: the Fastify request behind it.
 *
 * Structural on purpose — the context a programmatic handler receives and the one `$p.context()` hands a
 * decorated handler both satisfy it, so an upload is read the same way whichever way the route was declared.
 */
export interface MultipartContext {
  readonly platform: { readonly request: FastifyRequest }
}

/** The multipart readers bound to one request. See {@link multipart}. */
export interface MultipartHelpers {
  /**
   * The first file, buffered into memory, or `undefined` when the request carries none.
   *
   * With a `fieldname`, the first file sent under that name; files before it are drained and discarded, since
   * the parser cannot advance past a file nobody consumed.
   */
  file(fieldname?: string): Promise<File | undefined>

  /** Every file, each buffered into memory. */
  files(): Promise<File[]>

  /** Every part — fields and files alike — buffered into a `FormData`. */
  formData(): Promise<FormData>

  /**
   * The first file as a Node stream of one `MultipartFileNode`, selected by `fieldname` as
   * {@link MultipartHelpers.file} selects it.
   *
   * The caller must consume each yielded `stream`: the parser blocks until it is drained.
   */
  streamFile(fieldname?: string): Readable

  /** Every file as a Node object stream of `MultipartFileNode`. The caller drains each `stream`. */
  streamFiles(): Readable

  /**
   * Every part as a Node object stream of `MultipartFileNode` or {@link MultipartField}, in the order
   * they were sent. The caller drains each file's `stream`.
   */
  streamParts(): Readable

  /** The first file as a Web stream of one {@link WebMultipartFile}, selected by `fieldname`. */
  webStreamFile(fieldname?: string): ReadableStream<WebMultipartFile>

  /** Every file as a Web stream of {@link WebMultipartFile}. */
  webStreamFiles(): ReadableStream<WebMultipartFile>

  /** Every part as a Web stream of {@link WebMultipartFile} or {@link MultipartField}, in the order sent. */
  webStreamParts(): ReadableStream<WebMultipartFile | MultipartField>
}

/**
 * Reads a `multipart/form-data` request off the context.
 *
 * ```ts
 * uploads.post('/').handler(async ctx => {
 *   const avatar = await multipart(ctx).file('avatar')
 * })
 * ```
 *
 * Each call starts from wherever the parser currently stands, so one request is read once: a `file()` after a
 * `files()` finds nothing left. The request must have been routed through `@fastify/multipart` — the plugin's
 * `.with(() => multipartPlugin())` — and the route must not also declare a body picker, which would consume the same bytes.
 */
export function multipart(ctx: MultipartContext): MultipartHelpers {
  const request = ctx.platform.request

  return {
    file: fieldname => readFile(request, fieldname),
    files: () => readFiles(request),
    formData: () => readFormData(request),
    streamFile: fieldname => nodeStreamFile(request, fieldname),
    streamFiles: () => nodeStreamFiles(request),
    streamParts: () => nodeStreamParts(request),
    webStreamFile: fieldname => webStreamFile(request, fieldname),
    webStreamFiles: () => webStreamFiles(request),
    webStreamParts: () => webStreamParts(request),
  }
}
