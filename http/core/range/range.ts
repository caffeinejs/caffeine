import { Blob as NodeBlob } from 'node:buffer'

import { errMessage } from '@caffeinejs/std/err'

// The largest offset Node's `Blob.slice` takes: past it, Node aborts the process instead of throwing.
const LARGEST_SLICEABLE = 2 ** 32 - 1

/**
 * Several ranges of `body` as one `multipart/byteranges` body, laid out as RFC 9110 §14.6 has it.
 *
 * Each part opens with the boundary's delimiter, names `type` and its range, and holds its bytes after a blank line;
 * the close delimiter ends the body. A `Blob`'s parts are slices of it, read as the answer is sent; bytes are copied
 * once, into the `Blob` that holds the answer. `type` and `boundary` are written as given, so neither may hold a line
 * break.
 *
 * Each `[first, last]` is whole bytes inside the body, `0 <= first <= last < size`, as {@link byteRanges} returns
 * them.
 *
 * @throws {@link RangeError} for a range that is not, and for a range of a `Blob` ending at byte `2 ** 32 - 1` or
 * later: Node cannot cut a part out of a `Blob` past 4 GiB, and aborts the process when asked to.
 */
export function multipartByteRanges(
  body: NodeBlob | Uint8Array<ArrayBuffer>,
  ranges: ReadonlyArray<readonly [number, number]>,
  type: string,
  boundary: string,
): NodeBlob {
  const size = body instanceof NodeBlob ? body.size : body.byteLength
  const parts: Array<string | NodeBlob | Uint8Array<ArrayBuffer>> = []

  for (const [start, end] of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= size) {
      throw new RangeError(
        errMessage(`Cannot cut bytes ${start}-${end} out of a body of ${size} bytes: the range is not inside it`)
          .solutions('Pass whole byte offsets with 0 <= first <= last < size, as byteRanges() returns them')
          .build(),
      )
    }

    if (body instanceof NodeBlob && end + 1 > LARGEST_SLICEABLE) {
      throw new RangeError(
        errMessage(`Cannot slice bytes ${start}-${end} of a Blob: Node takes offsets up to ${LARGEST_SLICEABLE} only`)
          .solutions('Send a Blob past 4 GiB whole, without ranges, as Attachment() does')
          .build(),
      )
    }

    parts.push(
      `--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`,
      body instanceof NodeBlob ? body.slice(start, end + 1) : body.subarray(start, end + 1),
      '\r\n',
    )
  }

  parts.push(`--${boundary}--\r\n`)

  return new NodeBlob(parts)
}
