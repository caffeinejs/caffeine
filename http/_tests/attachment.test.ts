import { Readable } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Attachment, Controller, ErrConfiguration, Get, Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import {
  expectPatternedBody,
  expectRangeAnswer,
  extendedName,
  NAMED_DOWNLOAD,
  streamOf,
  type RangeAnswer,
} from './bodies.js'
import { patterned } from './patterned.js'

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

// A name as a route gives it, and the plain file name a client is told to save it under; `undefined` for none.
const names: Array<[given: string, saved: string | undefined]> = [
  ['report.pdf', 'report.pdf'],
  ['Q3 report (final).pdf', 'Q3 report (final).pdf'],
  ['say "hi".txt', 'say "hi".txt'],
  ['semi;colon,comma.txt', 'semi;colon,comma.txt'],
  ["it's 100%.txt", "it's 100%.txt"],
  ['résumé 2026.pdf', 'résumé 2026.pdf'],
  ['日本語.pdf', '日本語.pdf'],
  ['🎉 party.png', '🎉 party.png'],
  ['تقرير.pdf', 'تقرير.pdf'],
  [`${'a'.repeat(996)}.pdf`, `${'a'.repeat(996)}.pdf`],
  // A name is one file, never a place: only its last segment is kept, whichever separator it uses.
  ['../../etc/passwd', 'passwd'],
  ['C:\\Users\\me\\report.pdf', 'report.pdf'],
  ['back\\slash;semi,comma.txt', 'slash;semi,comma.txt'],
  // Nothing that could cut the name short or show it in another order: control characters and reordering marks.
  ['evil\r\nSet-Cookie: stolen=1.txt', 'evilSet-Cookie: stolen=1.txt'],
  ['nul\u0000byte.txt', 'nulbyte.txt'],
  ['invoice\u202Etxt.exe', 'invoicetxt.exe'],
  ['\uFEFFbom.txt', 'bom.txt'],
  // Nothing left a file could be named.
  ['..', undefined],
  ['.', undefined],
  ['reports/', undefined],
  ['\u202E\u0000', undefined],
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
// A stream as a file opens one, so whether each was closed can be seen: a 304 reads none of it.
const opened: Array<{ kind: string; closed: boolean }> = []
routes.get('/node-stream').handler(() => {
  const stream = { kind: 'node', closed: false }
  opened.push(stream)
  return Attachment(
    new Readable({
      read() {
        this.push(BODY)
        this.push(null)
      },
      destroy(err, callback) {
        stream.closed = true
        callback(err)
      },
    }),
    { etag: ETAG },
  )
})
routes.get('/web-stream').handler(() => {
  const stream = { kind: 'web', closed: false }
  opened.push(stream)
  return Attachment(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(BODY)
        controller.close()
      },
      cancel() {
        stream.closed = true
      },
    }),
    { etag: ETAG },
  )
})
routes.get('/web-stream-failing-close').handler(() =>
  Attachment(
    new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error('Cannot close the export: the storage connection dropped')
      },
    }),
    { etag: ETAG },
  ),
)
routes.get('/empty').handler(() => Attachment(new Blob([]), { name: 'empty.txt' }))
routes.get('/unnamed').handler(() => Attachment(new Blob([BODY])))
routes.get('/file').handler(() => Attachment(new File([BODY], 'relatório Q3.pdf', { type: PDF })))
routes.get('/file-with-path').handler(() => Attachment(new File([BODY], '../uploads/report.pdf', { type: PDF })))
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
  .handler(() => Attachment(BODY, { name: 'report.pdf', etag: ETAG, lastModified: MODIFIED }))
routes.get('/missing').handler(ctx => {
  ctx.status(404)
  return Attachment(new Blob(['no such report']), { name: 'missing.txt' })
})
names.forEach(([given], i) => routes.get(`/named/${i}`).handler(() => Attachment(new Blob(['x']), { name: given })))

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

  it.each(
    names.flatMap(([given, saved], i) => (saved === undefined ? [] : [[JSON.stringify(given), i, saved] as const])),
  )(
    'writes %s as a plain file name that decodes back exactly, in a header of visible ASCII alone',
    async (_label, i, saved) => {
      const res = await app.fetch(`/files/named/${i}`)

      const disposition = res.headers.get('content-disposition')!
      expect(res.status).toBe(200)
      expect(disposition).toMatch(NAMED_DOWNLOAD)
      expect(extendedName(disposition)).toBe(saved)
    },
  )

  it.each(names.flatMap(([given, saved], i) => (saved === undefined ? [[JSON.stringify(given), i] as const] : [])))(
    'names no file at all for %s, which leaves nothing a file could be called',
    async (_label, i) => {
      const res = await app.fetch(`/files/named/${i}`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBe('attachment')
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
    const res = await app.fetch(`/files/named/${names.findIndex(([given]) => given === name)}`)

    expect(res.headers.get('content-disposition')).toBe(header)
  })

  it('cannot be made to write a header of its own by a name holding a line break', async () => {
    const res = await app.fetch(`/files/named/${names.findIndex(([given]) => given.startsWith('evil'))}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="evilSet-Cookie: stolen=1.txt"; filename*=UTF-8''evilSet-Cookie%3A%20stolen%3D1.txt`,
    )
  })

  it("names a File's download after the File", async () => {
    const res = await app.fetch('/files/file')

    expect(extendedName(res.headers.get('content-disposition')!)).toBe('relatório Q3.pdf')
  })

  it("reduces a File's own name to a plain file name too", async () => {
    const res = await app.fetch('/files/file-with-path')

    expect(extendedName(res.headers.get('content-disposition')!)).toBe('report.pdf')
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
    await expectPatternedBody(res, 0, SIZE)
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

const ranges: Array<[string, RangeAnswer]> = [
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

    expect(res.headers.get('accept-ranges')).toBe('bytes')
    await expectRangeAnswer(res, expected, SIZE)
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
    await expectPatternedBody(res, 0, SIZE)
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
    ['a date, when the content has no Last-Modified', '/files/array-buffer', MODIFIED.toUTCString(), 200],
  ])('given %s', async (_validator, path, ifRange, status) => {
    const res = await app.fetch(path, { headers: { range: 'bytes=10-19', 'if-range': ifRange } })

    // Short of a 206, the whole current body: what the client holds is stale, and a part of the new one would
    // corrupt it.
    await expectRangeAnswer(res, status === 206 ? { status, start: 10, end: 19 } : { status: 200 }, SIZE)
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

describe('Attachment() answers a client that already holds the content with 304 (If-None-Match, If-Modified-Since)', () => {
  const later = new Date(MODIFIED.getTime() + 60_000).toUTCString()
  const earlier = new Date(MODIFIED.getTime() - 1000).toUTCString()

  it.each([
    ['If-None-Match: *', { 'if-none-match': '*' }],
    ['its strong tag', { 'if-none-match': ETAG }],
    ['its tag marked weak: If-None-Match compares weakly', { 'if-none-match': 'W/"report-v1"' }],
    ['a list holding its tag', { 'if-none-match': '"report-v0", "report-v1"' }],
    ['a list whose first tag holds a comma', { 'if-none-match': '"v0,v1", "report-v1"' }],
    ['If-Modified-Since its Last-Modified', { 'if-modified-since': MODIFIED.toUTCString() }],
    ['If-Modified-Since a later date', { 'if-modified-since': later }],
    [
      'a range, with its tag in If-None-Match: preconditions come before ranges',
      { range: 'bytes=0-9', 'if-none-match': ETAG },
    ],
  ])('given %s, on GET and HEAD alike', async (_case, headers) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.fetch('/files/bytes', { method, headers })

      expect(res.status).toBe(304)
      expect(res.headers.get('etag')).toBe(ETAG)
      expect(res.headers.get('last-modified')).toBe(MODIFIED.toUTCString())
      expect(res.headers.get('content-disposition')).toBeNull()
      expect(res.headers.get('accept-ranges')).toBeNull()
      expect(res.headers.get('content-range')).toBeNull()
      expect(await res.text()).toBe('')
    }
  })

  it.each([
    ['another tag', '/files/bytes', { 'if-none-match': '"report-v2"' }],
    [
      'another tag and a later date: If-None-Match decides alone',
      '/files/bytes',
      { 'if-none-match': '"report-v2"', 'if-modified-since': later },
    ],
    ['If-Modified-Since a second before its Last-Modified', '/files/bytes', { 'if-modified-since': earlier }],
    ['If-Modified-Since that does not parse', '/files/bytes', { 'if-modified-since': 'yesterday' }],
    ['a tag sent without its quotes, which names no entity tag', '/files/bytes', { 'if-none-match': 'report-v1' }],
    ['a tag, to content that has none', '/files/array-buffer', { 'if-none-match': ETAG }],
    ['a date, to content that has no Last-Modified', '/files/array-buffer', { 'if-modified-since': later }],
  ])('sends the whole body given %s', async (_case, path, headers) => {
    const res = await app.fetch(path, { headers })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).not.toBeNull()
    await expectPatternedBody(res, 0, SIZE)
  })

  it.each(['node', 'web'])('closes a %s stream it leaves unread, so a file behind one is closed too', async kind => {
    const changed = await app.fetch(`/files/${kind}-stream`, { headers: { 'if-none-match': '"report-v2"' } })
    expect(changed.status).toBe(200)
    await expectPatternedBody(changed, 0, SIZE)

    const res = await app.fetch(`/files/${kind}-stream`, { headers: { 'if-none-match': ETAG } })

    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    expect(opened.at(-1)).toEqual({ kind, closed: true })
  })

  // Left to reject, the failed close would be an unhandled rejection, which ends a Node process.
  it('answers 304 even when the stream it leaves unread fails as it closes', async () => {
    const res = await app.fetch('/files/web-stream-failing-close', { headers: { 'if-none-match': ETAG } })

    expect(res.status).toBe(304)
  })

  it('leaves a POST, and a status the route set, to their own answer whatever the validators say', async () => {
    const posted = await app.fetch('/files/blob', { method: 'POST', headers: { 'if-none-match': ETAG } })
    expect(posted.status).toBe(200)
    await expectPatternedBody(posted, 0, SIZE)

    const created = await app.fetch('/files/created', { headers: { 'if-none-match': ETAG } })
    expect(created.status).toBe(201)
    await expectPatternedBody(created, 0, SIZE)
  })
})
