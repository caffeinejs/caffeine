import { Blob as NodeBlob } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { byteRanges, multipartByteRanges } from './range.js'

describe('byteRanges reads the ranges a Range header asks of a body (RFC 9110 §14)', () => {
  it('reads a closed range, an open-ended one and a suffix', () => {
    expect(byteRanges('bytes=0-4', 10)).toEqual([[0, 4]])
    expect(byteRanges('bytes=5-', 10)).toEqual([[5, 9]])
    expect(byteRanges('bytes=-3', 10)).toEqual([[7, 9]])
  })

  it('keeps the order asked for, skipping empty list elements and the whitespace around each', () => {
    expect(byteRanges('bytes= 6-7 ,, 0-1 ', 10)).toEqual([
      [6, 7],
      [0, 1],
    ])
  })

  it('compares the unit without regard to case', () => {
    expect(byteRanges('Bytes=0-0', 10)).toEqual([[0, 0]])
  })

  it('ends a range running past the body at its last byte, and a suffix longer than the body at its first', () => {
    expect(byteRanges('bytes=8-100', 10)).toEqual([[8, 9]])
    expect(byteRanges('bytes=-100', 10)).toEqual([[0, 9]])
  })

  it('leaves out a range starting past the end, and is unsatisfiable when that leaves none', () => {
    expect(byteRanges('bytes=10-, 0-0', 10)).toEqual([[0, 0]])
    expect(byteRanges('bytes=10-12', 10)).toBe('unsatisfiable')
    expect(byteRanges('bytes=-0', 10)).toBe('unsatisfiable')
  })

  // RFC 9110 §14.2: a server may ignore Range, and a header it cannot read is better answered whole than refused.
  // Endpoints past 2 ** 53 round to the same number; compared as numbers, this reversed range would read as one
  // starting past the end and be left out, and the second served.
  it('sends the body whole for a range reversed in digits too long to be exact as numbers', () => {
    expect(byteRanges('bytes=9007199254740993-9007199254740992,0-0', 10)).toBe(undefined)
    expect(byteRanges('bytes=0010-9,0-0', 10)).toBe(undefined)
    expect(byteRanges('bytes=009-10', 10)).toEqual([[9, 9]])
  })

  it('sends the body whole for no header, another unit, or a malformed or reversed range', () => {
    for (const header of [
      undefined,
      'items=0-1',
      'bytes',
      'bytes=',
      'bytes= , ',
      'bytes=a-b',
      'bytes=-',
      'bytes=5-2',
    ]) {
      expect(byteRanges(header, 10), String(header)).toBe(undefined)
    }
  })

  it('sends an empty body whole, which has no byte to range over', () => {
    expect(byteRanges('bytes=0-0', 0)).toBe(undefined)
  })

  // Only a broken client or an attack asks for more than these; slicing them would cost the server, not the client.
  it('sends the body whole past 100 ranges, or for ranges adding up to more than the body', () => {
    const ranges = (n: number) => `bytes=${Array.from({ length: n }, (_, i) => `${i}-${i}`).join(',')}`

    expect(byteRanges(ranges(100), 1000)).toHaveLength(100)
    expect(byteRanges(ranges(101), 1000)).toBe(undefined)
    expect(byteRanges('bytes=0-5, 3-9', 10)).toBe(undefined)
  })
})

describe('multipartByteRanges lays several ranges out as one multipart/byteranges body (RFC 9110 §14.6)', () => {
  const expected =
    '--b0\r\nContent-Type: text/plain\r\nContent-Range: bytes 0-1/10\r\n\r\n01\r\n' +
    '--b0\r\nContent-Type: text/plain\r\nContent-Range: bytes 7-9/10\r\n\r\n789\r\n' +
    '--b0--\r\n'
  const ranges = [
    [0, 1],
    [7, 9],
  ] as const

  it('writes each part with its delimiter, type, range and bytes, then the close delimiter, from a Blob', async () => {
    const body = multipartByteRanges(new NodeBlob(['0123456789']), ranges, 'text/plain', 'b0')

    expect(await body.text()).toBe(expected)
  })

  it('writes the same layout from bytes', async () => {
    const body = multipartByteRanges(new TextEncoder().encode('0123456789'), ranges, 'text/plain', 'b0')

    expect(await body.text()).toBe(expected)
  })

  // Node's Blob.slice takes 32-bit offsets and aborts the whole process on a larger one, where an error could be
  // caught. The Blob is built of one MiB repeated, which allocates nothing more.
  it('throws a RangeError for a Blob range ending past the last byte a Blob can be cut at', async () => {
    const mib = new NodeBlob([new Uint8Array(1024 * 1024)])
    const large = new NodeBlob(Array.from({ length: 4097 }, () => mib))
    const last = 2 ** 32 - 2

    const body = multipartByteRanges(large, [[last, last]], 'application/octet-stream', 'b0')
    expect(await body.text()).toContain(`Content-Range: bytes ${last}-${last}/${large.size}`)
    expect(() =>
      multipartByteRanges(
        large,
        [
          [0, 0],
          [last, last + 1],
        ],
        'application/octet-stream',
        'b0',
      ),
    ).toThrow(RangeError)
  })

  // A caller passing its own ranges gets a RangeError it can catch, not an abort or a part from elsewhere in the body.
  it('throws a RangeError for a range that is not whole bytes inside the body', () => {
    const blob = new NodeBlob(['0123456789'])
    const bytes = new TextEncoder().encode('0123456789')

    for (const range of [
      [5, 4],
      [-1, 3],
      [0, -1],
      [8, 10],
      [0.5, 2],
      [0, Number.NaN],
    ] as const) {
      expect(() => multipartByteRanges(blob, [range], 'text/plain', 'b0'), String(range)).toThrow(RangeError)
      expect(() => multipartByteRanges(bytes, [range], 'text/plain', 'b0'), String(range)).toThrow(RangeError)
    }
  })

  // Node empties a reversed slice at its start, which past 32 bits aborts the process like any other offset.
  it('throws a RangeError for a reversed Blob range starting past the last byte a Blob can be cut at', () => {
    const mib = new NodeBlob([new Uint8Array(1024 * 1024)])
    const large = new NodeBlob(Array.from({ length: 4097 }, () => mib))

    expect(() => multipartByteRanges(large, [[2 ** 32, 0]], 'application/octet-stream', 'b0')).toThrow(RangeError)
  })
})
