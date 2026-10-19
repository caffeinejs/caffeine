import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Attachment, Controller, ErrConfiguration, Get, Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import { firstMismatch, patterned } from './patterned.js'

/**
 * A download a route builds itself — an export, a generated report, bytes read from object storage — named for the
 * client and served in ranges, so a large one cut off part-way resumes instead of starting over.
 */

const PDF = 'application/pdf'
const OCTET = 'application/octet-stream'
const SIZE = 1000
const BODY = patterned(0, SIZE)
const ETAG = '"report-v1"'
// Milliseconds included on purpose: Last-Modified carries seconds, and If-Range is compared at that precision.
const MODIFIED = new Date('2026-10-01T12:34:56.789Z')

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice())
      controller.close()
    },
  })
}

/** The name `filename*` carries, decoded as RFC 8187 has a recipient decode it. */
function extendedName(disposition: string): string | undefined {
  const encoded = /filename\*=UTF-8''([^;]*)/.exec(disposition)?.[1]
  return encoded === undefined ? undefined : decodeURIComponent(encoded)
}

const names = [
  'report.pdf',
  'Q3 report (final).pdf',
  'say "hi".txt',
  'back\\slash;semi,comma.txt',
  "it's 100%.txt",
  'résumé 2026.pdf',
  '日本語.pdf',
  '🎉 party.png',
  'تقرير.pdf',
  `${'a'.repeat(996)}.pdf`,
  'evil\r\nSet-Cookie: stolen=1.txt',
  '../../etc/passwd',
]

const routes = new Router('/files')
routes
  .get('/blob')
  .handler(() =>
    Attachment(new Blob([BODY], { type: PDF }), { name: 'report.pdf', etag: ETAG, lastModified: MODIFIED }),
  )
routes.get('/bytes').handler(() => Attachment(BODY, { name: 'report.pdf', etag: ETAG, lastModified: MODIFIED }))
routes.get('/array-buffer').handler(() => Attachment(BODY.slice().buffer, { name: 'report.pdf' }))
routes.get('/stream').handler(() => Attachment(streamOf(BODY), { name: 'live.bin', etag: ETAG }))
routes.get('/empty').handler(() => Attachment(new Blob([]), { name: 'empty.txt' }))
routes.get('/unnamed').handler(() => Attachment(new Blob([BODY])))
routes.get('/file').handler(() => Attachment(new File([BODY], 'relatório Q3.pdf', { type: PDF })))
routes
  .get('/file-renamed')
  .handler(() => Attachment(new File([BODY], 'tmp-7f3a.pdf', { type: PDF }), { name: 'report.pdf' }))
routes.get('/weak').handler(() => Attachment(BODY, { etag: 'W/"report-v1"' }))
routes.get('/typed').handler(() => Attachment(BODY, { type: 'text/csv' }))
routes
  .get('/produces')
  .produces('text/csv')
  .handler(() => Attachment(new Blob([BODY], { type: PDF })))
routes
  .get('/typed-over-produces')
  .produces('text/csv')
  .handler(() => Attachment(new Blob([BODY], { type: 'text/plain' }), { type: PDF }))
routes.post('/blob').handler(() => Attachment(new Blob([BODY], { type: PDF }), { name: 'report.pdf', etag: ETAG }))
routes
  .get('/created')
  .status(201)
  .handler(() => Attachment(BODY, { name: 'report.pdf' }))
routes.get('/missing').handler(ctx => {
  ctx.status(404)
  return Attachment(new Blob(['no such report']), { name: 'missing.txt' })
})
names.forEach((name, i) => routes.get(`/named/${i}`).handler(() => Attachment(new Blob(['x']), { name })))

@Controller('/files-controller')
class ReportsController {
  @Get('/report')
  report() {
    return Attachment(new Blob([BODY], { type: PDF }), { name: 'report.pdf' })
  }
}

void [ReportsController]

const app = createWebApplication().mount(routes)

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

describe('Attachment() names the download', () => {
  it('writes the name both as a plain fallback and as UTF-8 for the clients that read it', async () => {
    const res = await app.fetch('/files/blob')

    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    )
  })

  it.each(names.map((name, i) => [JSON.stringify(name), i, name] as const))(
    'writes %s so that it decodes back exactly, in a header made of visible ASCII alone',
    async (_label, i, name) => {
      const res = await app.fetch(`/files/named/${i}`)

      const disposition = res.headers.get('content-disposition')!
      expect(res.status).toBe(200)
      // The fallback is a quoted-string holding neither a quote nor a backslash, which clients unescape unevenly.
      expect(disposition).toMatch(
        /^attachment; filename="[\x20\x21\x23-\x5b\x5d-\x7e]*"; filename\*=UTF-8''[\x21-\x7e]*$/,
      )
      expect(extendedName(disposition)).toBe(name)
    },
  )

  it.each([
    ['résumé 2026.pdf', `attachment; filename="r_sum_ 2026.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%202026.pdf`],
    ['say "hi".txt', `attachment; filename="say _hi_.txt"; filename*=UTF-8''say%20%22hi%22.txt`],
    ["it's 100%.txt", `attachment; filename="it's 100%.txt"; filename*=UTF-8''it%27s%20100%25.txt`],
    ['🎉 party.png', `attachment; filename="_ party.png"; filename*=UTF-8''%F0%9F%8E%89%20party.png`],
    [
      'Q3 report (final).pdf',
      `attachment; filename="Q3 report (final).pdf"; filename*=UTF-8''Q3%20report%20%28final%29.pdf`,
    ],
  ])('falls back to a name a client without UTF-8 support can still save: %s', async (name, header) => {
    const res = await app.fetch(`/files/named/${names.indexOf(name)}`)

    expect(res.headers.get('content-disposition')).toBe(header)
  })

  it('cannot be made to write a header of its own by a name holding a line break', async () => {
    const res = await app.fetch(`/files/named/${names.indexOf('evil\r\nSet-Cookie: stolen=1.txt')}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="evil__Set-Cookie: stolen=1.txt"; filename*=UTF-8''evil%0D%0ASet-Cookie%3A%20stolen%3D1.txt`,
    )
  })

  it("names a File's download after the File", async () => {
    const res = await app.fetch('/files/file')

    expect(extendedName(res.headers.get('content-disposition')!)).toBe('relatório Q3.pdf')
  })

  it("lets the name given win over the File's own", async () => {
    const res = await app.fetch('/files/file-renamed')

    expect(extendedName(res.headers.get('content-disposition')!)).toBe('report.pdf')
  })

  it('makes an unnamed body a download all the same, leaving the client to name it', async () => {
    const res = await app.fetch('/files/unnamed')

    expect(res.headers.get('content-disposition')).toBe('attachment')
  })

  it('works from a decorated controller as from a router', async () => {
    const res = await app.fetch('/files-controller/report')

    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    )
    expect(res.headers.get('content-type')).toBe(PDF)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(firstMismatch(body, 0)).toBe(-1)
  })
})

describe('Attachment() writes the validators a client resumes against', () => {
  it('writes the ETag and Last-Modified it was given, and says ranges are served', async () => {
    const res = await app.fetch('/files/blob')

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe(ETAG)
    expect(res.headers.get('last-modified')).toBe(MODIFIED.toUTCString())
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(SIZE))
  })
})

describe('Attachment() decides the Content-Type', () => {
  it.each([
    ['its own type option', '/files/typed', 'text/csv'],
    ["the route's declared type over the Blob's", '/files/produces', /^text\/csv/],
    ["its own type option over the route's", '/files/typed-over-produces', PDF],
    ["the Blob's own type when nothing else names one", '/files/blob', PDF],
    ['application/octet-stream for bytes nothing names', '/files/array-buffer', OCTET],
  ])('takes %s, on the whole body and on every range of it', async (_rule, path, type) => {
    const whole = await app.fetch(path)
    const part = await app.fetch(path, { headers: { range: 'bytes=10-19' } })

    expect(part.status).toBe(206)
    for (const res of [whole, part]) {
      if (typeof type === 'string') {
        expect(res.headers.get('content-type')).toBe(type)
      } else {
        expect(res.headers.get('content-type')).toMatch(type)
      }
    }
  })
})

type Expected = { status: 206; start: number; end: number } | { status: 416 } | { status: 200 }

const ranges: Array<[string, Expected]> = [
  ['bytes=0-4', { status: 206, start: 0, end: 4 }],
  ['bytes=0-0', { status: 206, start: 0, end: 0 }],
  ['bytes=-1', { status: 206, start: 999, end: 999 }],
  ['bytes=3-', { status: 206, start: 3, end: 999 }],
  ['bytes=-3', { status: 206, start: 997, end: 999 }],
  ['bytes=0-', { status: 206, start: 0, end: 999 }],
  ['bytes=0-999999', { status: 206, start: 0, end: 999 }],
  ['bytes=-2000', { status: 206, start: 0, end: 999 }],
  ['Bytes=0-4', { status: 206, start: 0, end: 4 }],
  ['bytes=0005-0009', { status: 206, start: 5, end: 9 }],
  ['bytes= 0-4', { status: 206, start: 0, end: 4 }],
  ['bytes=0-4,', { status: 206, start: 0, end: 4 }],
  ['bytes=1000-', { status: 416 }],
  ['bytes=-0', { status: 416 }],
  ['bytes=99999999999999999999-', { status: 416 }],
  ['bytes=5-2', { status: 200 }],
  ['bytes=abc', { status: 200 }],
  ['bytes=-', { status: 200 }],
  ['bytes=', { status: 200 }],
  ['bytes=1-2-3', { status: 200 }],
  ['bytes 0-4', { status: 200 }],
  ['items=0-4', { status: 200 }],
  ['bytes=0-1,4-5', { status: 200 }],
]

describe.each([
  ['a Blob', '/files/blob'],
  ['a Uint8Array', '/files/bytes'],
  ['an ArrayBuffer', '/files/array-buffer'],
])('Attachment() of %s answers a range', (_kind, path) => {
  it.each(ranges)('%s with %o', async (range, expected) => {
    const res = await app.fetch(path, { headers: { range } })

    expect(res.status).toBe(expected.status)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const body = new Uint8Array(await res.arrayBuffer())

    if (expected.status === 206) {
      const length = expected.end - expected.start + 1
      expect(res.headers.get('content-range')).toBe(`bytes ${expected.start}-${expected.end}/${SIZE}`)
      expect(res.headers.get('content-length')).toBe(String(length))
      expect(body.length).toBe(length)
      expect(firstMismatch(body, expected.start)).toBe(-1)
    } else if (expected.status === 416) {
      expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`)
      expect(body.length).toBe(0)
    } else {
      expect(res.headers.get('content-range')).toBeNull()
      expect(body.length).toBe(SIZE)
      expect(firstMismatch(body, 0)).toBe(-1)
    }
  })
})

describe('Attachment() leaves a range unanswered where one does not apply', () => {
  it('sends an empty body whole, whatever range is asked for', async () => {
    for (const range of ['bytes=0-', 'bytes=-5', 'bytes=0-0']) {
      const res = await app.fetch('/files/empty', { headers: { range } })

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    }
  })

  it('answers HEAD with the whole length and the download headers, and no body', async () => {
    const res = await app.fetch('/files/blob', { method: 'HEAD', headers: { range: 'bytes=0-4' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(SIZE))
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    )
    expect(await res.text()).toBe('')
  })

  it('sends the whole body to a POST: ranges are defined for GET alone', async () => {
    const res = await app.fetch('/files/blob', { method: 'POST', headers: { range: 'bytes=0-4' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-range')).toBeNull()
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE)
  })

  it('sends a stream whole, and does not offer ranges of a body whose length it does not know', async () => {
    const res = await app.fetch('/files/stream', { headers: { range: 'bytes=0-4', 'if-range': ETAG } })

    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBeNull()
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="live.bin"; filename*=UTF-8''live.bin`)
    expect(res.headers.get('etag')).toBe(ETAG)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(SIZE)
    expect(firstMismatch(body, 0)).toBe(-1)
  })
})

describe('Attachment() resumes only the body the client already holds part of (If-Range)', () => {
  it.each([
    ['the same strong ETag', '/files/bytes', ETAG, 206],
    ['a different ETag: the content changed', '/files/bytes', '"report-v2"', 200],
    ['a weak ETag, which never proves the bytes are the same', '/files/bytes', 'W/"report-v1"', 200],
    ['any ETag, when the content has only a weak one', '/files/weak', 'W/"report-v1"', 200],
    ['the Last-Modified date', '/files/bytes', MODIFIED.toUTCString(), 206],
    ['a date a second earlier', '/files/bytes', new Date(MODIFIED.getTime() - 1000).toUTCString(), 200],
    ['a date a second later', '/files/bytes', new Date(MODIFIED.getTime() + 1000).toUTCString(), 200],
    ['a date that does not parse', '/files/bytes', 'yesterday', 200],
    ['any validator, when the content has none', '/files/array-buffer', ETAG, 200],
  ])('given %s', async (_validator, path, ifRange, status) => {
    const res = await app.fetch(path, { headers: { range: 'bytes=10-19', 'if-range': ifRange } })

    expect(res.status).toBe(status)
    const body = new Uint8Array(await res.arrayBuffer())
    if (status === 206) {
      expect(res.headers.get('content-range')).toBe(`bytes 10-19/${SIZE}`)
      expect(firstMismatch(body, 10)).toBe(-1)
    } else {
      // The whole current body: what the client holds is stale, so a part of the new one would corrupt it.
      expect(body.length).toBe(SIZE)
      expect(firstMismatch(body, 0)).toBe(-1)
    }
  })

  it('has no effect without a Range', async () => {
    const res = await app.fetch('/files/bytes', { headers: { 'if-range': ETAG } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-range')).toBeNull()
  })
})

describe('Attachment() answers a range only in place of a 200', () => {
  it.each([
    ['a status the route declared', '/files/created', 201, SIZE],
    ['a status the handler set', '/files/missing', 404, 'no such report'.length],
  ])('keeps %s and sends the body whole', async (_source, path, status, length) => {
    const res = await app.fetch(path, { headers: { range: 'bytes=0-4' } })

    expect(res.status).toBe(status)
    expect(res.headers.get('content-range')).toBeNull()
    expect((await res.arrayBuffer()).byteLength).toBe(length)
  })
})

describe('Attachment() refuses validators that would fail without a word', () => {
  it.each(['v1', '"v1', 'v1"', 'W/v1', 'w/"v1"', '"v 1"', '"v"1"', ''])(
    'refuses %j as an ETag: a client echoes it back, and an unquoted one never matches',
    etag => {
      expect(() => Attachment(BODY, { etag })).toThrow(ErrConfiguration)
    },
  )

  it('names the ETag it refused and how to write it', () => {
    expect(() => Attachment(BODY, { etag: 'v1' })).toThrow(/^Cannot use "v1" as an ETag: .*\n.*Write it as "\\"v1\\""/s)
  })

  it.each(['"v1"', 'W/"v1"', '""', '"sha-256:9f86d081"'])('takes %j as an ETag', etag => {
    expect(() => Attachment(BODY, { etag })).not.toThrow()
  })

  it('refuses a Date that holds no time: the header would read "Invalid Date"', () => {
    expect(() => Attachment(BODY, { lastModified: new Date('not a date') })).toThrow(ErrConfiguration)
  })
})
