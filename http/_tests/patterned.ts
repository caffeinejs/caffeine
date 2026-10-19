/**
 * Test bodies whose every byte says where it sits: each aligned 8-byte word holds its own offset, big-endian. A
 * range served from the wrong place, or a byte dropped or repeated anywhere, shows up as wrong bytes, not just as
 * a wrong length — and any slice of a body, however large, can be checked without holding the body.
 */

const WORD = 8
const HIGH = 2 ** 32

/** The byte of the pattern at `offset`. */
export function byteAt(offset: number): number {
  const word = offset - (offset % WORD)
  const index = offset % WORD
  const half = index < 4 ? Math.floor(word / HIGH) : word % HIGH
  const shift = 8 * (3 - (index % 4))

  return (half >>> shift) & 0xff
}

/** `length` bytes of the pattern, starting at `offset`. */
export function patterned(offset: number, length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)

  for (let i = 0; i < length; i++) {
    bytes[i] = byteAt(offset + i)
  }

  return bytes
}

/**
 * Where `bytes` first parts from the pattern laid down from `offset`, or `-1` when every byte matches.
 *
 * Asserted as `expect(firstMismatch(bytes, offset)).toBe(-1)`, a failure names one position instead of printing
 * two buffers that may be megabytes long.
 */
export function firstMismatch(bytes: Uint8Array, offset: number): number {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== byteAt(offset + i)) {
      return i
    }
  }

  return -1
}
