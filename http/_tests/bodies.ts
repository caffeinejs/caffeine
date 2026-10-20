import { expect } from 'vitest'

import { firstMismatch } from './patterned.js'

/** `bytes` as a web stream, handed out `chunk` bytes at a time as the reader asks. */
export function streamOf(bytes: Uint8Array, chunk = 256): ReadableStream<Uint8Array> {
  let offset = 0

  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }

      controller.enqueue(bytes.slice(offset, offset + chunk))
      offset += chunk
    },
  })
}

/** That the body of `res` is the pattern from `offset`, `length` bytes of it when given; the body, read. */
export async function expectPatternedBody(res: Response, offset = 0, length?: number): Promise<Uint8Array> {
  const body = new Uint8Array(await res.arrayBuffer())

  if (length !== undefined) {
    expect(body.length).toBe(length)
  }
  expect(firstMismatch(body, offset)).toBe(-1)

  return body
}

/** A `Content-Disposition` naming a download twice; its plain name holds neither a quote nor a backslash. */
export const NAMED_DOWNLOAD = /^attachment; filename="[\x20\x21\x23-\x5b\x5d-\x7e]*"; filename\*=UTF-8''[\x21-\x7e]*$/

/** The name `filename*` carries, decoded as RFC 8187 has a recipient decode it. */
export function extendedName(disposition: string): string | undefined {
  const encoded = /filename\*=UTF-8''([^;]*)/.exec(disposition)?.[1]
  return encoded === undefined ? undefined : decodeURIComponent(encoded)
}

/**
 * What a `Range` request should get: one part of the body, several parts of it as `multipart/byteranges` in the
 * order asked for, a refusal, or the whole of it.
 */
export type RangeAnswer =
  | { status: 206; start: number; end: number }
  | { status: 206; parts: ReadonlyArray<readonly [start: number, end: number]> }
  | { status: 416 }
  | { status: 200 }

/** One part of a `multipart/byteranges` body: the type and range its header lines name, and the bytes it holds. */
export interface BytePart {
  type: string | undefined
  start: number
  end: number
  size: number
  bytes: Uint8Array
}

// RFC 2046 §5.1.1: one to seventy characters of `bchars`, the last of them not a space.
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/

/**
 * Reads a `multipart/byteranges` body as strictly as RFC 9110 §14.6 and RFC 2046 §5.1.1 lay it out: the body opens
 * with the boundary's delimiter; each part holds header lines, a blank line and exactly the bytes its
 * `Content-Range` names, followed at once by the next delimiter; the last part by the closing one, and nothing after
 * it but a line break. Reading a part by the length it declares and then demanding the delimiter is what catches a
 * wrong length, a stray byte or a missing line break.
 */
export function parseByteRanges(contentType: string | null, body: Uint8Array): BytePart[] {
  const match = /^multipart\/byteranges;\s*boundary=(?:"([^"]+)"|([^\s;]+))$/i.exec(contentType ?? '')
  expect(match, `a multipart/byteranges Content-Type, got ${JSON.stringify(contentType)}`).not.toBeNull()
  const boundary = match![1] ?? match![2]
  expect(boundary).toMatch(BOUNDARY)

  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const text = (from: number, to: number) => bytes.toString('latin1', from, to)
  let at = 0
  const expectNext = (expected: string) => {
    expect(text(at, at + expected.length)).toBe(expected)
    at += expected.length
  }

  const parts: BytePart[] = []
  expectNext(`--${boundary}\r\n`)

  for (;;) {
    const headersEnd = bytes.indexOf('\r\n\r\n', at, 'latin1')
    expect(headersEnd, "a blank line ending the part's header lines").toBeGreaterThanOrEqual(at)

    const fields = new Map<string, string>()
    for (const line of text(at, headersEnd).split('\r\n')) {
      const colon = line.indexOf(':')
      expect(colon, `a header line, got ${JSON.stringify(line)}`).toBeGreaterThan(0)
      fields.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
    }
    at = headersEnd + 4

    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(fields.get('content-range') ?? '')
    expect(
      range,
      `a Content-Range of one satisfied range, got ${JSON.stringify(fields.get('content-range'))}`,
    ).not.toBeNull()
    const [start, end, size] = range!.slice(1).map(Number)
    const length = end - start + 1
    expect(at + length).toBeLessThanOrEqual(bytes.length)

    parts.push({ type: fields.get('content-type'), start, end, size, bytes: bytes.subarray(at, at + length) })
    at += length

    expectNext(`\r\n--${boundary}`)
    if (text(at, at + 2) === '--') {
      at += 2
      break
    }
    expectNext('\r\n')
  }

  expect(['', '\r\n']).toContain(text(at, bytes.length))

  return parts
}

/**
 * That `res` answers a range of the pattern's first `size` bytes as `expected` says, bytes and headers agreeing. The
 * parts of a multipart answer each carry `partType`, the type the whole body would go out under.
 */
export async function expectRangeAnswer(
  res: Response,
  expected: RangeAnswer,
  size: number,
  partType: string | RegExp = 'application/octet-stream',
): Promise<void> {
  expect(res.status).toBe(expected.status)

  if (expected.status === 206 && 'parts' in expected) {
    const body = new Uint8Array(await res.arrayBuffer())
    // RFC 9110 §14.6: each part names its own range, and the whole answer none.
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('content-length')).toBe(String(body.length))

    const parts = parseByteRanges(res.headers.get('content-type'), body)
    expect(parts.map(part => [part.start, part.end])).toEqual(expected.parts.map(([start, end]) => [start, end]))
    for (const part of parts) {
      if (typeof partType === 'string') {
        expect(part.type).toBe(partType)
      } else {
        expect(part.type).toMatch(partType)
      }
      expect(part.size).toBe(size)
      expect(firstMismatch(part.bytes, part.start)).toBe(-1)
    }
  } else if (expected.status === 206) {
    const length = expected.end - expected.start + 1
    expect(res.headers.get('content-range')).toBe(`bytes ${expected.start}-${expected.end}/${size}`)
    expect(res.headers.get('content-length')).toBe(String(length))
    await expectPatternedBody(res, expected.start, length)
  } else if (expected.status === 416) {
    expect(res.headers.get('content-range')).toBe(`bytes */${size}`)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  } else {
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('content-length')).toBe(String(size))
    await expectPatternedBody(res, 0, size)
  }
}
