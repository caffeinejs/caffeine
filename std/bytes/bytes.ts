import { ErrInvalidByteSize } from './errors.js'

export type ByteSize = number | string

/**
 * JSON Schema `pattern` for a {@link ByteSize} string.
 *
 * Anchored; mirrors the grammar {@link bytes} accepts — an integer, optionally followed by one unit.
 * The case alternatives are spelled out because a JSON Schema `pattern` carries no flags.
 */
export const BYTES_PATTERN = '^\\d+(?:[bB]|[kKmMgGtTpP][bB]?)?$'

const UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
}

const re = /^(\d+)([bB]|[kKmMgGtTpP][bB]?)?$/

const GRAMMAR = 'expected an integer optionally followed by b, kb, mb, gb, tb or pb'

/**
 * Reads a byte size written the way a Docker Compose file writes one — `'512kb'`, `'10MB'`, `'2g'` —
 * as a count of bytes.
 *
 * Every prefix is binary: `'1kb'`, `'1k'` and `'1KB'` are all 1024. The Kubernetes spellings are
 * deliberately not accepted, because that specification reads `1k` as 1000 and writes 1024 as `1Ki`;
 * one string cannot mean both. A unitless value, string or number, is already a count of bytes.
 *
 * Unparseable input throws rather than reading as `0`, since the callers are size limits and a limit of
 * zero rejects every payload.
 *
 * @throws {@link ErrInvalidByteSize} if the string is outside the grammar, if the number is not a
 * finite non-negative integer, or if the result is too large to hold exactly.
 */
export function bytes(value: ByteSize): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ErrInvalidByteSize(value, 'expected a non-negative integer no larger than Number.MAX_SAFE_INTEGER')
    }

    return value
  }

  const match = re.exec(value)

  if (match === null) {
    throw new ErrInvalidByteSize(value, GRAMMAR)
  }

  const total = Number(match[1]) * (match[2] === undefined ? 1 : UNITS[match[2].toLowerCase()[0]]!)

  if (!Number.isSafeInteger(total)) {
    throw new ErrInvalidByteSize(value, 'result exceeds Number.MAX_SAFE_INTEGER')
  }

  return total
}
