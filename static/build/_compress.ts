import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

import { KiB } from '@caffeinejs/std/bytes'

import type { Encoding } from '../manifest/manifest.js'

/** The smallest file worth a variant: below it, a compressed copy saves less than a request's headers. */
export const SMALLEST_COMPRESSED = 1 * KiB

/** A variant is kept only when it is at most this share of the identity's size. */
export const KEPT_RATIO = 0.95

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/**
 * `bytes` in `encoding` at the highest level, since a file is compressed once and sent many times. Deterministic for
 * one zlib: gzip writes no time, and brotli emits the same bytes for the same parameters.
 */
export function compress(bytes: Buffer, encoding: Encoding): Promise<Buffer> {
  return encoding === 'br'
    ? brotli(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      })
    : gzipAsync(bytes, { level: constants.Z_BEST_COMPRESSION })
}
