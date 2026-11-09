import { createHash } from 'node:crypto'
import { constants as fs, createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createBrotliCompress, createGzip } from 'node:zlib'

import { KiB } from '@caffeinejs/std/bytes'

import type { Encoding } from '../manifest/manifest.js'

/** The smallest file worth a variant: below it, a compressed copy saves less than a request's headers. */
export const SMALLEST_COMPRESSED = 1 * KiB

/** A variant is kept only when it is at most this share of the identity's size. */
export const KEPT_RATIO = 0.95

/**
 * Compresses the file at `source` of `size` bytes into a new file at `target`, in `encoding` at the highest level,
 * since a file is compressed once and sent many times, and returns the written file's SHA-256 and size.
 *
 * Streamed, so memory holds a chunk at a time whatever the file's size. Deterministic for one zlib: gzip writes no
 * time, brotli emits the same bytes for the same parameters, and the file is read in chunks of the same size every
 * build. `target` must not exist.
 */
export async function compressFile(
  source: string,
  target: string,
  encoding: Encoding,
  size: number,
): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256')
  let written = 0
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      written += chunk.byteLength
      callback(null, chunk)
    },
  })
  const coder =
    encoding === 'br'
      ? createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: size,
          },
        })
      : createGzip({ level: constants.Z_BEST_COMPRESSION })

  // Undefined where a platform has no `O_NOFOLLOW`, which `|` reads as 0. The stream closes the handle.
  const handle = await open(source, fs.O_RDONLY | fs.O_NOFOLLOW)

  await pipeline(handle.createReadStream(), coder, counted, createWriteStream(target, { flags: 'wx' }))

  return { hash: hash.digest('base64'), size: written }
}
