import { ErrInvalidByteSize } from './errors.js'

/**
 * A size, as a count of bytes: the unit buffers, streams and body limits take.
 *
 * Write one with the unit constants, `512 * KiB` or `10 * MiB`, read one from text with {@link parseBytes} or
 * {@link bytes}, and print one with {@link formatBytes}. Every unit is binary, as text reads it: `'1kb'` is
 * `1 * KiB`, so there is no decimal `KB`.
 */
export type ByteSize = number

export const Byte: ByteSize = 1
export const KiB: ByteSize = 1_024
export const MiB: ByteSize = 1_048_576
export const GiB: ByteSize = 1_073_741_824
export const TiB: ByteSize = 1_099_511_627_776
/** The largest unit: a size holds at most a little under eight of them, `Number.MAX_SAFE_INTEGER` bytes. */
export const PiB: ByteSize = 1_125_899_906_842_624

/**
 * JSON Schema `pattern` for byte text in configuration.
 *
 * Anchored: the grammar {@link parseBytes} reads. A pattern cannot hold its bound, so text past
 * `Number.MAX_SAFE_INTEGER` bytes passes it and the parser refuses it. The case alternatives are spelled out because a
 * JSON Schema `pattern` carries no flags.
 */
export const BYTES_PATTERN = '^\\d+(?:[bB]|[kKmMgGtTpP][bB]?)?$'

const re = /^(\d+)([bB]|[kKmMgGtTpP][bB]?)?$/

// Each unit by its letter, lower case. The `b` after it changes nothing.
const UNITS: ReadonlyMap<string, ByteSize> = new Map([
  ['b', Byte],
  ['k', KiB],
  ['m', MiB],
  ['g', GiB],
  ['t', TiB],
  ['p', PiB],
])

// The units text is written in, largest first.
const SPELLINGS: ReadonlyArray<readonly [unit: ByteSize, spelling: string]> = [
  [PiB, 'pb'],
  [TiB, 'tb'],
  [GiB, 'gb'],
  [MiB, 'mb'],
  [KiB, 'kb'],
]

const GRAMMAR = 'expected an integer optionally followed by b, kb, mb, gb, tb or pb'
const OUT_OF_RANGE = 'out of range: a byte size is at most 9007199254740991 bytes, one under 8pb'
const NOT_A_SIZE = 'expected a whole number of bytes from 0 to 9007199254740991'

/**
 * Reads byte text as a {@link ByteSize}, the way a Docker Compose file writes one: `'512kb'`, `'10MB'`, `'2g'`.
 *
 * An integer, optionally followed by one unit: `b`, `k` or `kb`, `m` or `mb`, `g` or `gb`, `t` or `tb`, `p` or `pb`,
 * in any case. Every unit is binary: `'1kb'`, `'1k'` and `'1KB'` are all `1 * KiB`, and a bare `'1024'` is bytes. No
 * sign, fraction or space.
 *
 * The Kubernetes spellings are refused, because that specification reads `1k` as 1000 and writes 1024 as `1Ki`; one
 * string cannot mean both.
 *
 * @throws {@link ErrInvalidByteSize} if the text is outside the grammar, or comes to more than
 * `Number.MAX_SAFE_INTEGER` bytes.
 */
export function parseBytes(text: string): ByteSize {
  const match = re.exec(text)

  if (match === null) {
    throw new ErrInvalidByteSize(text, GRAMMAR)
  }

  const unit = match[2] === undefined ? Byte : UNITS.get(match[2].charAt(0).toLowerCase())!
  // A power of two scales exactly, so a product that is still safe is the exact size.
  const size = Number(match[1]) * unit

  if (!Number.isSafeInteger(size)) {
    throw new ErrInvalidByteSize(text, OUT_OF_RANGE)
  }

  return size
}

/**
 * Reads a size written either way, as text or as a {@link ByteSize}.
 *
 * Text goes through {@link parseBytes}; a number is already a count of bytes and passes through.
 *
 * @example
 * // A third-party option in bytes
 * multipartPlugin({ limits: { fileSize: bytes('10mb') } })
 *
 * @throws {@link ErrInvalidByteSize} if the text is outside the grammar, or the size is not a whole number of bytes
 * from 0 to `Number.MAX_SAFE_INTEGER`.
 */
export function bytes(value: ByteSize | string): ByteSize {
  if (typeof value === 'string') {
    return parseBytes(value)
  }

  if (!isByteSize(value)) {
    throw new ErrInvalidByteSize(value, NOT_A_SIZE)
  }

  return value
}

/**
 * Writes a {@link ByteSize} as text, in the largest unit that holds it exactly: `'1mb'`, `'512kb'`, `'1536b'`.
 *
 * Zero is `'0b'`. The output reads back with {@link parseBytes}. A value that is not a whole number of bytes is
 * written as JavaScript writes it, so this never throws.
 */
export function formatBytes(size: ByteSize): string {
  if (!isByteSize(size)) {
    return String(size)
  }

  if (size !== 0) {
    for (const [unit, spelling] of SPELLINGS) {
      if (size % unit === 0) {
        return `${size / unit}${spelling}`
      }
    }
  }

  // `-0` is a size too, and prints as `0`.
  return `${size}b`
}

function isByteSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
