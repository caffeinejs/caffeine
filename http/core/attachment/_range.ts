import { Blob as NodeBlob } from 'node:buffer'

// The most ranges one request is served, as Spring caps them: past it, the body goes out whole (RFC 9110 §14.2: a
// server MAY ignore Range).
const MOST_RANGES = 100

// The byte ranges a `Range` header asks of a body of `size` bytes, as RFC 9110 §14 reads it: each `[first, last]`
// inside the body, in the order asked for, with those starting past its end left out, or `'unsatisfiable'` when that
// leaves none. `undefined` when the body is to be sent whole: another unit, a malformed or reversed range, an empty
// body, more than `MOST_RANGES` ranges, or ranges adding up to more than the body, which only a broken client or an
// attack asks for (§14.2), and Go's server sends whole too.
export function byteRanges(
  header: string | undefined,
  size: number,
): ReadonlyArray<readonly [number, number]> | 'unsatisfiable' | undefined {
  if (header === undefined || size === 0) {
    return undefined
  }

  // The unit is compared without regard to case.
  const equals = header.indexOf('=')
  if (equals === -1 || header.slice(0, equals).toLowerCase() !== 'bytes') {
    return undefined
  }

  // Empty list elements are skipped, as a list's recipient must.
  const specs = header
    .slice(equals + 1)
    .split(',')
    .map(spec => spec.trim())
    .filter(spec => spec !== '')
  if (specs.length === 0 || specs.length > MOST_RANGES) {
    return undefined
  }

  const ranges: Array<readonly [number, number]> = []
  let total = 0

  for (const spec of specs) {
    const range = rangeOf(spec, size)

    if (range === undefined) {
      return undefined
    }

    if (range !== 'unsatisfiable') {
      ranges.push(range)
      total += range[1] - range[0] + 1
    }
  }

  if (ranges.length === 0) {
    return 'unsatisfiable'
  }

  return total > size ? undefined : ranges
}

// One range of a body of `size` bytes, `'unsatisfiable'` for one starting past its end, `undefined` for one that is
// malformed or reversed.
function rangeOf(spec: string, size: number): readonly [number, number] | 'unsatisfiable' | undefined {
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) {
    return undefined
  }

  const [, first, last] = match

  // A suffix: the last bytes of the body, all of it when it asks for more than there is.
  if (first === '') {
    if (last === '') {
      return undefined
    }

    const length = Number(last)
    return length === 0 ? 'unsatisfiable' : [Math.max(size - length, 0), size - 1]
  }

  const start = Number(first)

  if (last !== '' && Number(last) < start) {
    return undefined
  }

  if (start >= size) {
    return 'unsatisfiable'
  }

  return [start, last === '' ? size - 1 : Math.min(Number(last), size - 1)]
}

// Several ranges of `body` as one `multipart/byteranges` body, laid out as RFC 9110 §14.6 has it: each part opens with
// the boundary's delimiter, names its type and range, and holds its bytes after a blank line; the close delimiter
// ends the body. A Blob's parts are slices of it, read as the answer is sent; bytes are copied once, into the Blob
// that holds the answer.
export function multipartByteRanges(
  body: NodeBlob | Uint8Array<ArrayBuffer>,
  ranges: ReadonlyArray<readonly [number, number]>,
  type: string,
  boundary: string,
): NodeBlob {
  const size = body instanceof NodeBlob ? body.size : body.byteLength
  const parts: Array<string | NodeBlob | Uint8Array<ArrayBuffer>> = []

  for (const [start, end] of ranges) {
    parts.push(
      `--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`,
      body instanceof NodeBlob ? body.slice(start, end + 1) : body.subarray(start, end + 1),
      '\r\n',
    )
  }

  parts.push(`--${boundary}--\r\n`)

  return new NodeBlob(parts)
}
