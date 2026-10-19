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

/** What a `Range` request should get: one part of the body, a refusal, or the whole of it. */
export type RangeAnswer = { status: 206; start: number; end: number } | { status: 416 } | { status: 200 }

/** That `res` answers a range of the pattern's first `size` bytes as `expected` says, bytes and headers agreeing. */
export async function expectRangeAnswer(res: Response, expected: RangeAnswer, size: number): Promise<void> {
  expect(res.status).toBe(expected.status)

  if (expected.status === 206) {
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
