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
})
