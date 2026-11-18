import { constants as buffers } from 'node:buffer'
import { Duplex, type Transform } from 'node:stream'
import {
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  constants,
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createGunzip,
  createGzip,
  createInflate,
  createZstdCompress,
  createZstdDecompress,
  deflate,
  deflateSync,
  gunzip,
  gzip,
  gzipSync,
  inflate,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
  type BrotliOptions,
  type Zlib,
  type ZstdOptions,
} from 'node:zlib'

import { KiB, MiB, type ByteSize } from '@caffeinejs/std/bytes'

import { ErrHTTP, ErrHTTPBadRequest } from '../error/http.js'
import { contentTooLarge } from '../server/body.js'
import type { ContentCoding, ResolvedCodecs } from './compress.js'

/**
 * Below it a body is coded on the calling thread, where a threadpool round trip costs more than the work; above it,
 * on the libuv threadpool.
 */
const SYNC_LIMIT = 16 * KiB

/** The most a body decoded on the calling thread may inflate to: about a millisecond of work. */
const SYNC_OUTPUT_LIMIT = 1 * MiB

type Callback = (err: Error | null, result: Buffer) => void

/** A zlib coder: a Node transform that also flushes. */
type Coder = Transform & Zlib

/**
 * `bytes` in `coding`: on the calling thread up to 16 KiB at a level fast enough for it, which takes tens of
 * microseconds; on the libuv threadpool above it, or at a slower level, where Brotli's 11 takes milliseconds.
 */
export function compressBytes(
  coding: ContentCoding,
  bytes: Uint8Array,
  codecs: ResolvedCodecs,
): Uint8Array | Promise<Uint8Array> {
  const sync = bytes.byteLength <= SYNC_LIMIT && fast(coding, codecs)

  switch (coding) {
    case 'gzip':
      return sync ? gzipSync(bytes, codecs.gzip) : oneShot(done => gzip(bytes, codecs.gzip, done))
    case 'deflate':
      return sync ? deflateSync(bytes, codecs.deflate) : oneShot(done => deflate(bytes, codecs.deflate, done))
    case 'br': {
      const options = brotliOptions(codecs, bytes.byteLength)
      return sync ? brotliCompressSync(bytes, options) : oneShot(done => brotliCompress(bytes, options, done))
    }
    case 'zstd': {
      const options = zstdOptions(codecs)
      return sync ? zstdCompressSync(bytes, options) : oneShot(done => zstdCompress(bytes, options, done))
    }
  }
}

/**
 * `body` compressed in `coding` as it is read. With `feed`, each chunk is flushed once written, so what the
 * application sent reaches the client without waiting for the coder's window to fill: a feed of records stays a feed.
 * Without it the coder flushes when it chooses, which codes a body of known length smaller and sooner.
 */
export function compressStream(
  coding: ContentCoding,
  body: ReadableStream<Uint8Array>,
  codecs: ResolvedCodecs,
  feed: boolean,
): ReadableStream<Uint8Array> {
  switch (coding) {
    case 'gzip':
      return body.pipeThrough(transformOf(createGzip(codecs.gzip), feed ? constants.Z_SYNC_FLUSH : undefined))
    case 'deflate':
      return body.pipeThrough(transformOf(createDeflate(codecs.deflate), feed ? constants.Z_SYNC_FLUSH : undefined))
    case 'br':
      return body.pipeThrough(
        transformOf(createBrotliCompress(brotliOptions(codecs)), feed ? constants.BROTLI_OPERATION_FLUSH : undefined),
      )
    case 'zstd':
      return body.pipeThrough(
        transformOf(createZstdCompress(zstdOptions(codecs)), feed ? constants.ZSTD_e_flush : undefined),
      )
  }
}

/**
 * `bytes` decoded from `coding`, at most `limit` of them: on the calling thread up to 16 KiB of coded bytes, on the
 * libuv threadpool above it.
 *
 * Rejects with a 413 past `limit`, and with a 400 for bytes that are not `coding`'s.
 */
export function decompressBytes(coding: ContentCoding, bytes: Uint8Array, limit: ByteSize): Promise<Uint8Array> {
  // An empty body is empty in any coding: a client that codes every request codes an empty one too.
  if (bytes.byteLength === 0) {
    return Promise.resolve(bytes)
  }

  // In place only while what it may inflate to stays small: past it, a small bomb would hold the event loop.
  if (bytes.byteLength <= SYNC_LIMIT && limit <= SYNC_OUTPUT_LIMIT) {
    try {
      return Promise.resolve(whole(decompressSync(coding, bytes, limit), bytes, coding))
    } catch (err) {
      return Promise.reject(decodeFailure(err, coding, limit))
    }
  }

  // No larger than the largest buffer the runtime makes, which refuses a larger one: 4 GiB on Bun.
  const most = Math.min(limit, buffers.MAX_LENGTH)
  const decoded = (() => {
    switch (coding) {
      case 'gzip':
        return oneShot(done => gunzip(bytes, { maxOutputLength: most, info: true }, done))
      case 'deflate':
        return oneShot(done => inflate(bytes, { maxOutputLength: most, info: true }, done))
      case 'br':
        return oneShot(done => brotliDecompress(bytes, { maxOutputLength: most, info: true }, done))
      case 'zstd':
        return oneShot(done => zstdDecompress(bytes, { maxOutputLength: most, params: ZSTD_WINDOW, info: true }, done))
    }
  })()

  return decoded.then(
    result => whole(result, bytes, coding),
    (err: unknown) => {
      throw decodeFailure(err, coding, limit)
    },
  )
}

function decompressSync(coding: ContentCoding, bytes: Uint8Array, limit: ByteSize): unknown {
  switch (coding) {
    case 'gzip':
      return gunzipSync(bytes, { maxOutputLength: limit, info: true })
    case 'deflate':
      return inflateSync(bytes, { maxOutputLength: limit, info: true })
    case 'br':
      return brotliDecompressSync(bytes, { maxOutputLength: limit, info: true })
    case 'zstd':
      return zstdDecompressSync(bytes, { maxOutputLength: limit, params: ZSTD_WINDOW, info: true })
  }
}

/**
 * Whether the coder used all of the input that is content. gunzip stops at a zero byte after a member, the padding
 * some writers add, and leaves the rest unread: that is padding only when every byte of it is zero. `lastNonZero`
 * gives the offset of the input's last byte that is not zero, `-1` when there is none.
 */
function consumed(coding: ContentCoding, used: number, received: number, lastNonZero: () => number): boolean {
  return used === received || (coding === 'gzip' && lastNonZero() < used)
}

// The offset of the last byte of `bytes` that is not zero, `-1` when there is none.
function lastNonZeroOf(bytes: Uint8Array): number {
  let at = bytes.byteLength - 1
  while (at >= 0 && bytes[at] === 0) {
    at--
  }
  return at
}

/** A one-shot decode run with `info: true`: what it decoded, and how much of the input the coder used. */
interface Decoded {
  readonly buffer: Uint8Array
  readonly engine: { readonly bytesWritten: number }
}

// What a one-shot run with `info: true` decoded, when the coded content was all of `bytes`: bytes after it are not
// part of it. `@types/node` types the result as the bytes alone.
function whole(result: unknown, bytes: Uint8Array, coding: ContentCoding): Uint8Array {
  const decoded = result as Decoded
  if (!consumed(coding, decoded.engine.bytesWritten, bytes.byteLength, () => lastNonZeroOf(bytes))) {
    throw invalid(coding)
  }
  return decoded.buffer
}

// Past the limit is a 413; anything else, bytes that are not `coding`'s.
function decodeFailure(err: unknown, coding: ContentCoding, limit: ByteSize): ErrHTTP {
  return (err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ? contentTooLarge(limit) : invalid(coding)
}

/**
 * `body` decoded from `coding` as it is read. The coder runs only as far as the reader pulls, so a few bytes that
 * inflate to gigabytes are never inflated past what the reader's limit lets through.
 *
 * Errors with a 400 for bytes that are not `coding`'s; what `body` fails with, such as the limit's 413 or a client
 * gone, stands. An empty body is empty.
 */
export function decompressStream(coding: ContentCoding, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = (() => {
    switch (coding) {
      case 'gzip':
        return createGunzip()
      case 'deflate':
        return createInflate()
      case 'br':
        return createBrotliDecompress()
      case 'zstd':
        return createZstdDecompress({ params: ZSTD_WINDOW })
    }
  })()

  // The coded bytes, counted, and what they failed with: a failure of the body is not one of its coding.
  const source = body.getReader()
  let received = 0
  // The offset of the last byte received that is not zero, to tell gzip's zero padding from other bytes.
  let lastNonZero = -1
  let failure: unknown
  let failed = false
  const counted = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await source.read()
          if (next.done) {
            controller.close()
          } else {
            const at = coding === 'gzip' ? lastNonZeroOf(next.value) : -1
            if (at >= 0) {
              lastNonZero = received + at
            }
            received += next.value.byteLength
            controller.enqueue(next.value)
          }
        } catch (err) {
          failure = err
          failed = true
          controller.error(err)
        }
      },
      cancel: reason => source.cancel(reason),
    },
    { highWaterMark: 0 },
  )

  const pair = Duplex.toWeb(decoder) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  const reader = counted.pipeThrough(pair).getReader()

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read()
          if (!next.done) {
            controller.enqueue(next.value)
          } else if (consumed(coding, decoder.bytesWritten, received, () => lastNonZero)) {
            controller.close()
          } else {
            // Bytes after the coded content are not part of it.
            controller.error(invalid(coding))
          }
        } catch (err) {
          if (failed) {
            controller.error(failure)
          } else if (received === 0) {
            controller.close()
          } else {
            controller.error(err instanceof ErrHTTP ? err : invalid(coding))
          }
        }
      },
      cancel: reason => reader.cancel(reason),
    },
    // Pulled only when read, so the decoder holds no more than the reader asked for.
    { highWaterMark: 0 },
  )
}

// A transform over a zlib coder, flushing after every chunk written when given a `kind` of flush.
function transformOf(coder: Coder, kind: number | undefined): TransformStream<Uint8Array, Uint8Array> {
  let failure: Error | undefined

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      coder.on('data', (chunk: Buffer) => controller.enqueue(chunk))
      coder.on('error', (err: Error) => {
        failure = err
        controller.error(err)
      })
    },
    transform(chunk) {
      return new Promise<void>((resolve, reject) => {
        const settle = (): void => (failure === undefined ? resolve() : reject(failure))
        if (kind === undefined) {
          coder.write(chunk, settle)
        } else {
          coder.write(chunk)
          coder.flush(kind, settle)
        }
      })
    },
    flush() {
      return new Promise<void>((resolve, reject) => {
        coder.once('end', resolve)
        coder.once('error', reject)
        coder.end()
      })
    },
    // The source failed or the client went away: the coder's memory goes now, not at collection.
    cancel() {
      coder.destroy()
    },
  })
}

// A zlib call with a callback, as a promise of its result.
function oneShot(run: (done: Callback) => void): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    run((err, result) => (err === null ? resolve(result) : reject(err)))
  })
}

// The levels that code 16 KiB in tens of microseconds; the ones above take milliseconds.
function fast(coding: ContentCoding, codecs: ResolvedCodecs): boolean {
  switch (coding) {
    case 'br':
      return codecs.br.quality <= 5
    case 'zstd':
      return codecs.zstd.level <= 9
    default:
      return true
  }
}

function brotliOptions(codecs: ResolvedCodecs, size?: number): BrotliOptions {
  const params: Record<number, number> = { [constants.BROTLI_PARAM_QUALITY]: codecs.br.quality }
  if (size !== undefined) {
    params[constants.BROTLI_PARAM_SIZE_HINT] = size
  }

  return { params }
}

function zstdOptions(codecs: ResolvedCodecs): ZstdOptions {
  return { params: { [constants.ZSTD_c_compressionLevel]: codecs.zstd.level } }
}

/** The largest zstd window a request body may ask for: the 8 MiB RFC 9659 has every decoder accept. */
const ZSTD_WINDOW: Readonly<Record<number, number>> = { [constants.ZSTD_d_windowLogMax]: 23 }

function invalid(coding: ContentCoding): ErrHTTPBadRequest {
  return new ErrHTTPBadRequest(`The request body is not valid ${coding} content`)
}
