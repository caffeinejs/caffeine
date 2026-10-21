import { Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  Attachment,
  Catch,
  Controller,
  ErrConfiguration,
  ErrHTTPPreconditionFailed,
  type ErrorHandler,
  Get,
  type IContext,
  Router,
} from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import {
  expectPatternedBody,
  expectRangeAnswer,
  extendedName,
  NAMED_DOWNLOAD,
  parseByteRanges,
  streamOf,
  type RangeAnswer,
} from './bodies.js'
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

// A catch handler that answers a missing report with a stand-in download.
class ErrReportMissing extends Error {}

@Catch(ErrReportMissing)
class StandInReport implements ErrorHandler<ErrReportMissing> {
  handle() {
    return Attachment(BODY, { name: 'stand-in.pdf', etag: '"stand-in-v1"' })
  }
}

const routes = new Router('/files').catchBy([StandInReport])
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
routes.get('/stand-in').handler(() => {
  throw new ErrReportMissing()
})
routes.get('/one-byte').handler(() => Attachment(patterned(0, 1)))
routes.get('/ten').handler(() => Attachment(new TextEncoder().encode('0123456789'), { type: 'text/plain' }))
routes.get('/handler-typed').handler(ctx => {
  ctx.header('content-type', 'text/markdown')
  return Attachment(BODY)
})
// An export stored compressed, served under its coding: the bytes ranges are taken of are the gzip bytes.
const CSV = 'region,order,total\n'.repeat(200)
const GZIPPED = new Uint8Array(gzipSync(CSV))
routes.get('/gzipped').handler(ctx => {
  ctx.header('content-encoding', 'gzip')
  return Attachment(GZIPPED, { name: 'orders.csv', type: 'text/csv' })
})
routes.get('/handler-typed-badly').handler(ctx => {
  ctx.header('content-type', 'text/plain\r\nX-Evil: yes')
  return Attachment(new Blob([BODY], { type: PDF }))
})
routes.get('/async-bytes').handler(async () => {
  await Promise.resolve()
  return Attachment(BODY, { etag: ETAG, lastModified: MODIFIED })
})
// Content that changes between requests, as a stored document does: each scenario keeps its own under an id.
const documents = new Map<string, { body: Uint8Array<ArrayBuffer>; etag: string }>()
routes.get('/documents/:id').handler(ctx => {
  const document = documents.get(ctx.req.param().id)!
  return Attachment(document.body, { name: 'document.pdf', type: PDF, etag: document.etag })
})
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

// An application that answers a stale download in its own words.
@Controller('/files-guarded')
class GuardedReportsController {
  @Get('/report')
  report() {
    return Attachment(BODY, { name: 'report.pdf', etag: ETAG })
  }

  @Catch(ErrHTTPPreconditionFailed)
  stale(ctx: IContext) {
    ctx.status(412)
    return { reason: 'The report changed since it was listed' }
  }
}

void [ReportsController, GuardedReportsController]

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
  // RFC 9110 §14.6: several satisfiable ranges are sent together, each part naming its own.
  [
    'bytes=0-1,4-5',
    {
      status: 206,
      parts: [
        [0, 1],
        [4, 5],
      ],
    },
  ],
  // §15.3.7.2: in the order the client asked for them.
  [
    'bytes=5-9,0-4',
    {
      status: 206,
      parts: [
        [5, 9],
        [0, 4],
      ],
    },
  ],
  [
    'bytes=999-999,0-0',
    {
      status: 206,
      parts: [
        [999, 999],
        [0, 0],
      ],
    },
  ],
  [
    'bytes=0-0,-1',
    {
      status: 206,
      parts: [
        [0, 0],
        [999, 999],
      ],
    },
  ],
  // §5.6.1: empty list elements and the whitespace around elements are a list's own.
  [
    'bytes=0-4,  ,9-9',
    {
      status: 206,
      parts: [
        [0, 4],
        [9, 9],
      ],
    },
  ],
  [
    'bytes=0-4, 9-9 ,',
    {
      status: 206,
      parts: [
        [0, 4],
        [9, 9],
      ],
    },
  ],
  // Overlapping parts are sent as asked, while together they are no more than the body.
  [
    'bytes=0-499,250-749',
    {
      status: 206,
      parts: [
        [0, 499],
        [250, 749],
      ],
    },
  ],
  [
    'bytes=0-0,0-0',
    {
      status: 206,
      parts: [
        [0, 0],
        [0, 0],
      ],
    },
  ],
  // §15.3.7.2: an unsatisfiable range is left out; one range left is a single part, never multipart.
  ['bytes=0-4,2000-', { status: 206, start: 0, end: 4 }],
  ['bytes=-0,0-4', { status: 206, start: 0, end: 4 }],
  // §15.5.17: none of them satisfiable.
  ['bytes=2000-,3000-', { status: 416 }],
  ['bytes=-0,1000-', { status: 416 }],
  // One invalid range makes the whole header one this server ignores (§14.2: a server MAY ignore Range).
  ['bytes=0-4,5-2', { status: 200 }],
  ['bytes=0-4,abc', { status: 200 }],
  // Ranges adding up to more than the body are a broken client or an attack (§14.2), and get the body once.
  ['bytes=0-599,0-599', { status: 200 }],
]

describe.each([
  ['a Blob', '/files/blob', PDF],
  ['a Uint8Array', '/files/bytes', OCTET],
  ['an ArrayBuffer', '/files/array-buffer', OCTET],
])('Attachment() of %s answers a range', (_kind, path, type) => {
  it.each(ranges)('%s with %o', async (range, expected) => {
    const res = await app.fetch(path, { headers: { range } })

    expect(res.headers.get('accept-ranges')).toBe('bytes')
    await expectRangeAnswer(res, expected, SIZE, type)
  })
})

describe('Attachment() sends several ranges as RFC 9110 §14.6 lays them out', () => {
  const spec = (ranges: ReadonlyArray<readonly [number, number]>) =>
    `bytes=${ranges.map(([start, end]) => `${start}-${end}`).join(',')}`
  const hundred = Array.from({ length: 100 }, (_, i) => [i * 10, i * 10] as const)

  it('writes exactly the delimiters, part headers and bytes of the RFC layout, ending with the close delimiter', async () => {
    const res = await app.fetch('/files/ten', { headers: { range: 'bytes=0-2,7-9' } })
    const body = Buffer.from(await res.arrayBuffer()).toString('latin1')
    const boundary = /boundary=(.+)$/.exec(res.headers.get('content-type')!)![1]

    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe(`multipart/byteranges; boundary=${boundary}`)
    expect(body).toBe(
      [
        `--${boundary}`,
        'Content-Type: text/plain',
        'Content-Range: bytes 0-2/10',
        '',
        '012',
        `--${boundary}`,
        'Content-Type: text/plain',
        'Content-Range: bytes 7-9/10',
        '',
        '789',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    )
    expect(res.headers.get('content-length')).toBe(String(body.length))
  })

  it.each([
    ["the Blob's own type", '/files/blob', PDF],
    ['application/octet-stream for bytes nothing names', '/files/bytes', OCTET],
    ["the route's declared type", '/files/produces', /^text\/csv/],
    ["its own type option over the route's", '/files/typed-over-produces', PDF],
    ['a type the handler set', '/files/handler-typed', 'text/markdown'],
  ])('labels every part with %s, the type the whole body goes out under', async (_rule, path, type) => {
    const res = await app.fetch(path, { headers: { range: 'bytes=0-4,10-14' } })

    expect(res.headers.get('content-type')).toMatch(/^multipart\/byteranges; boundary=/)
    await expectRangeAnswer(
      res,
      {
        status: 206,
        parts: [
          [0, 4],
          [10, 14],
        ],
      },
      SIZE,
      type,
    )
  })

  // Node drops such a value from the header it writes; written into a part, it would add lines of its own.
  it("never writes a type holding a control character into a part, falling back to the Blob's own", async () => {
    const res = await app.fetch('/files/handler-typed-badly', { headers: { range: 'bytes=0-4,10-14' } })
    const body = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(206)
    expect(Buffer.from(body).toString('latin1')).not.toContain('X-Evil')
    expect(parseByteRanges(res.headers.get('content-type'), body).map(part => part.type)).toEqual([PDF, PDF])
  })

  it('draws a new boundary for every answer, so no body can be made to hold its own', async () => {
    const [first, second] = await Promise.all(
      [0, 1].map(() => app.fetch('/files/bytes', { headers: { range: 'bytes=0-4,10-14' } })),
    )

    expect(first.headers.get('content-type')).not.toBe(second.headers.get('content-type'))
  })

  it('serves up to 100 ranges in one answer, and the whole body to a request for more', async () => {
    const most = await app.fetch('/files/bytes', { headers: { range: spec(hundred) } })
    await expectRangeAnswer(most, { status: 206, parts: hundred }, SIZE)

    const tooMany = await app.fetch('/files/bytes', { headers: { range: spec([...hundred, [5, 5]]) } })
    await expectRangeAnswer(tooMany, { status: 200 }, SIZE)
  })

  it('sends a one-byte body whole to two ranges of its one byte, which add up to more than it holds', async () => {
    const res = await app.fetch('/files/one-byte', { headers: { range: 'bytes=0-0,0-0' } })

    await expectRangeAnswer(res, { status: 200 }, 1)
  })
})

describe('Attachment() keeps the content coding a body carries (RFC 9110 §8.4)', () => {
  it('sends a coded body whole to several ranges: a multipart answer cannot carry the coding of what it slices', async () => {
    const res = await app.fetch('/files/gzipped', { headers: { range: 'bytes=0-9,20-29' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('content-type')).toBe('text/csv')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(CSV)
  })

  it('serves one range of a coded body as a part of its coded bytes, under the same coding', async () => {
    const res = await app.fetch('/files/gzipped', { headers: { range: 'bytes=0-9' } })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${GZIPPED.length}`)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZIPPED.subarray(0, 10))
  })
})

describe('Attachment() leaves a range unanswered where one does not apply', () => {
  it('sends an empty body whole, whatever range is asked for', async () => {
    for (const range of ['bytes=0-', 'bytes=-5', 'bytes=0-0', 'bytes=0-1,4-5']) {
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

  it('answers HEAD for several ranges as the whole GET would be answered', async () => {
    const res = await app.fetch('/files/blob', { method: 'HEAD', headers: { range: 'bytes=0-4,10-14' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(SIZE))
    expect(res.headers.get('content-type')).toBe(PDF)
    expect(res.headers.get('content-range')).toBeNull()
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

  it.each([
    ['the same strong ETag', ETAG, 206],
    ['the Last-Modified date', MODIFIED.toUTCString(), 206],
    ['a different ETag', '"report-v2"', 200],
    ['a weak ETag', 'W/"report-v1"', 200],
    ['another date', new Date(MODIFIED.getTime() + 1000).toUTCString(), 200],
  ])('serves several ranges together, or none, given %s', async (_validator, ifRange, status) => {
    const res = await app.fetch('/files/bytes', { headers: { range: 'bytes=10-19,30-39', 'if-range': ifRange } })

    await expectRangeAnswer(
      res,
      status === 206
        ? {
            status,
            parts: [
              [10, 19],
              [30, 39],
            ],
          }
        : { status: 200 },
      SIZE,
    )
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

describe('Attachment() refuses options that would fail without a word', () => {
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

  it.each(['text/plain\r\nX-Evil: yes', 'text/plain\u0000', 'text/plain\u007f'])(
    'refuses %j as a type: a header value holds no control character',
    type => {
      expect(() => Attachment(BODY, { type })).toThrow(ErrConfiguration)
    },
  )

  it('names the type it refused with its control characters escaped, so the message stays on one line', () => {
    expect(() => Attachment(BODY, { type: 'text/plain\r\nX-Evil: yes' })).toThrow(
      /^Cannot use "text\/plain\\r\\nX-Evil: yes" as a Content-Type: [^\n]*\n/,
    )
  })

  it.each(['text/plain; charset=utf-8', 'text/plain;\tcharset=utf-8', 'application/vnd.example+json'])(
    'takes %j as a type',
    type => {
      expect(() => Attachment(BODY, { type })).not.toThrow()
    },
  )

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
    ['If-Modified-Since its Last-Modified in rfc850 form', { 'if-modified-since': 'Thursday, 01-Oct-26 12:34:56 GMT' }],
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
    ['If-Modified-Since that is no HTTP-date, "2030"', '/files/bytes', { 'if-modified-since': '2030' }],
    ['a tag sent without its quotes, which names no entity tag', '/files/bytes', { 'if-none-match': 'report-v1' }],
    ['a tag, to content that has none', '/files/array-buffer', { 'if-none-match': ETAG }],
    ['a date, to content that has no Last-Modified', '/files/array-buffer', { 'if-modified-since': later }],
  ])('sends the whole body given %s', async (_case, path, headers) => {
    const res = await app.fetch(path, { headers })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).not.toBeNull()
    await expectPatternedBody(res, 0, SIZE)
  })

  // RFC 9110 §5.6.7: a two-digit year more than 50 years ahead is the most recent past year with those digits, so one
  // stamp names another year as the calendar moves on. The clock is fixed here, never left to the day the suite runs.
  it('reads a two-digit year against the year the request arrives in', async () => {
    const headers = { 'if-modified-since': 'Friday, 01-Oct-99 12:34:56 GMT' }
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      // In 2026, 99 is more than 50 years ahead: it is 1999, before the content last changed.
      vi.setSystemTime(new Date('2026-10-21T00:00:00Z'))
      const in2026 = await app.fetch('/files/bytes', { headers })
      expect(in2026.status).toBe(200)
      await expectPatternedBody(in2026, 0, SIZE)

      // In 2049 it is not: it is 2099, after.
      vi.setSystemTime(new Date('2049-06-01T00:00:00Z'))
      expect((await app.fetch('/files/bytes', { headers })).status).toBe(304)
    } finally {
      vi.useRealTimers()
    }
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

/** That `res` refuses a failed precondition with 412, in the framework's error body on a GET, describing no body. */
async function expectPreconditionFailed(res: Response, method: string): Promise<void> {
  expect(res.status).toBe(412)
  expect(res.headers.get('content-disposition')).toBeNull()
  expect(res.headers.get('accept-ranges')).toBeNull()
  expect(res.headers.get('content-range')).toBeNull()
  if (method === 'GET') {
    expect(await res.json()).toMatchObject({ statusCode: 412, code: 'ERR_HTTP_PRECONDITION_FAILED' })
  } else {
    expect(await res.text()).toBe('')
  }
}

describe('Attachment() refuses a client whose precondition no longer holds with 412 (If-Match, If-Unmodified-Since)', () => {
  const later = new Date(MODIFIED.getTime() + 60_000).toUTCString()
  const earlier = new Date(MODIFIED.getTime() - 1000).toUTCString()

  it.each([
    // RFC 9110 §13.1.1: If-Match compares strongly, so a weak tag never matches, either side.
    ['another tag', '/files/bytes', { 'if-match': '"report-v2"' }],
    ['the weak form of its own tag', '/files/bytes', { 'if-match': 'W/"report-v1"' }],
    ['its own tag, when that tag is weak', '/files/weak', { 'if-match': 'W/"report-v1"' }],
    ['a tag, to content that has none', '/files/array-buffer', { 'if-match': ETAG }],
    ['a value that names no entity tag', '/files/bytes', { 'if-match': 'report-v1' }],
    // §13.1.4: the content changed after the date the client holds.
    ['If-Unmodified-Since a second before its Last-Modified', '/files/bytes', { 'if-unmodified-since': earlier }],
    // §5.6.7: a recipient reads all three HTTP-date formats.
    [
      'If-Unmodified-Since a second earlier, in asctime form',
      '/files/bytes',
      { 'if-unmodified-since': 'Thu Oct  1 12:34:55 2026' },
    ],
  ])('given %s, on GET and HEAD alike', async (_case, path, headers) => {
    const validators = (await app.fetch(path)).headers

    for (const method of ['GET', 'HEAD']) {
      const res = await app.fetch(path, { method, headers })

      await expectPreconditionFailed(res, method)
      expect(res.headers.get('etag')).toBe(validators.get('etag'))
      expect(res.headers.get('last-modified')).toBe(validators.get('last-modified'))
    }
  })

  it.each([
    ['If-Match: *', '/files/bytes', { 'if-match': '*' }],
    ['If-Match: *, to content that has no tag', '/files/array-buffer', { 'if-match': '*' }],
    ['its own strong tag', '/files/bytes', { 'if-match': ETAG }],
    ['a list holding its tag', '/files/bytes', { 'if-match': '"report-v0", "report-v1"' }],
    ['a list whose first tag holds a comma', '/files/bytes', { 'if-match': '"v0,v1", "report-v1"' }],
    // Last-Modified carries seconds: the milliseconds the content has are not a change.
    ['If-Unmodified-Since its Last-Modified', '/files/bytes', { 'if-unmodified-since': MODIFIED.toUTCString() }],
    ['If-Unmodified-Since a later date', '/files/bytes', { 'if-unmodified-since': later }],
    ['If-Unmodified-Since that does not parse', '/files/bytes', { 'if-unmodified-since': 'yesterday' }],
    // §13.1.4: a value that is not an HTTP-date is ignored, however a date parser might read it.
    ['If-Unmodified-Since that is no HTTP-date, "2026"', '/files/bytes', { 'if-unmodified-since': '2026' }],
    [
      'If-Unmodified-Since naming a day February does not have',
      '/files/bytes',
      { 'if-unmodified-since': 'Tue, 31 Feb 2026 00:00:00 GMT' },
    ],
    [
      'If-Unmodified-Since in rfc850 form',
      '/files/bytes',
      { 'if-unmodified-since': 'Thursday, 01-Oct-26 12:34:56 GMT' },
    ],
    ['If-Unmodified-Since in asctime form', '/files/bytes', { 'if-unmodified-since': 'Thu Oct  1 12:34:56 2026' }],
    [
      'If-Unmodified-Since, to content with no Last-Modified',
      '/files/array-buffer',
      { 'if-unmodified-since': earlier },
    ],
  ])('sends the whole body given %s', async (_case, path, headers) => {
    const res = await app.fetch(path, { headers })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).not.toBeNull()
    await expectPatternedBody(res, 0, SIZE)
  })
})

describe('Attachment() evaluates preconditions in the order RFC 9110 §13.2.2 gives', () => {
  const later = new Date(MODIFIED.getTime() + 60_000).toUTCString()
  const earlier = new Date(MODIFIED.getTime() - 1000).toUTCString()

  it.each([
    [
      'a failing If-Match before a matching If-None-Match: 412, not 304',
      { 'if-match': '"report-v2"', 'if-none-match': ETAG },
    ],
    [
      'a failing If-Unmodified-Since before a matching If-None-Match',
      { 'if-unmodified-since': earlier, 'if-none-match': ETAG },
    ],
    ['a failing If-Match before a range: 412, not 206', { 'if-match': '"report-v2"', range: 'bytes=0-9' }],
    ['a failing If-Match before several ranges', { 'if-match': '"report-v2"', range: 'bytes=0-9,20-29' }],
  ])('refuses %s', async (_case, headers) => {
    await expectPreconditionFailed(await app.fetch('/files/bytes', { headers }), 'GET')
  })

  it('reads If-Unmodified-Since only without If-Match, which decides alone', async () => {
    const res = await app.fetch('/files/bytes', { headers: { 'if-match': ETAG, 'if-unmodified-since': earlier } })

    expect(res.status).toBe(200)
    await expectPatternedBody(res, 0, SIZE)
  })

  it('serves the range once every precondition holds', async () => {
    const res = await app.fetch('/files/bytes', {
      headers: { 'if-match': ETAG, 'if-unmodified-since': later, range: 'bytes=10-19,30-39', 'if-range': ETAG },
    })

    await expectRangeAnswer(
      res,
      {
        status: 206,
        parts: [
          [10, 19],
          [30, 39],
        ],
      },
      SIZE,
    )
  })

  it('refuses the same way from an async handler and from a catch handler as from a sync one', async () => {
    await expectPreconditionFailed(await app.fetch('/files/async-bytes', { headers: { 'if-match': '"x"' } }), 'GET')
    await expectPreconditionFailed(await app.fetch('/files/stand-in', { headers: { 'if-match': '"x"' } }), 'GET')

    const served = await app.fetch('/files/stand-in', { headers: { 'if-match': '"stand-in-v1"' } })
    expect(served.status).toBe(200)
    await expectPatternedBody(served, 0, SIZE)
  })
})

describe('Attachment() leaves preconditions to the handler where a 412 would come too late', () => {
  it('sends a POST its own answer: the handler already acted, and a 412 now would say it had not', async () => {
    const res = await app.fetch('/files/blob', { method: 'POST', headers: { 'if-match': '"report-v2"' } })

    expect(res.status).toBe(200)
    await expectPatternedBody(res, 0, SIZE)
  })

  it.each([
    ['a status the route declared', '/files/created', 201, SIZE],
    ['a status the handler set', '/files/missing', 404, 'no such report'.length],
  ])('keeps %s and sends the body whole', async (_source, path, status, length) => {
    const res = await app.fetch(path, { headers: { 'if-match': '"report-v2"', 'if-unmodified-since': 'yesterday' } })

    expect(res.status).toBe(status)
    expect((await res.arrayBuffer()).byteLength).toBe(length)
  })
})

describe('Attachment() refusing a precondition leaves nothing open and goes through error handling', () => {
  it.each(['node', 'web'])('closes a %s stream it refuses to send', async kind => {
    const res = await app.fetch(`/files/${kind}-stream`, { headers: { 'if-match': '"report-v2"' } })

    await expectPreconditionFailed(res, 'GET')
    expect(opened.at(-1)).toEqual({ kind, closed: true })
  })

  it('refuses with 412 even when the stream it closes fails as it closes', async () => {
    const res = await app.fetch('/files/web-stream-failing-close', { headers: { 'if-match': '"report-v2"' } })

    await expectPreconditionFailed(res, 'GET')
  })

  it("lets a @Catch handler answer the refusal in the application's own words", async () => {
    const res = await app.fetch('/files-guarded/report', { headers: { 'if-match': '"report-v0"' } })

    expect(res.status).toBe(412)
    expect(await res.json()).toEqual({ reason: 'The report changed since it was listed' })
  })
})

describe('Attachment() serves the clients that ask for parts of a download', () => {
  it('lets a download manager fetch the pieces it is missing together, and never splices two versions', async () => {
    documents.set('manager', { body: BODY, etag: '"manual-v1"' })
    const partsOf = async (res: Response) =>
      parseByteRanges(res.headers.get('content-type'), new Uint8Array(await res.arrayBuffer()))

    // The pieces a first attempt brought, then the gaps between them, asked for against the version they came from.
    const first = await app.fetch('/files/documents/manager', { headers: { range: 'bytes=0-99,200-599,700-999' } })
    const etag = first.headers.get('etag')!
    const pieces = await partsOf(first)
    const gaps = await partsOf(
      await app.fetch('/files/documents/manager', { headers: { range: 'bytes=100-199,600-699', 'if-range': etag } }),
    )

    expect(pieces.map(part => [part.start, part.end])).toEqual([
      [0, 99],
      [200, 599],
      [700, 999],
    ])
    expect(gaps.map(part => [part.start, part.end])).toEqual([
      [100, 199],
      [600, 699],
    ])
    const assembled = new Uint8Array(SIZE)
    for (const part of [...pieces, ...gaps]) {
      assembled.set(part.bytes, part.start)
    }
    expect(firstMismatch(assembled, 0)).toBe(-1)

    // The document changes; the same request for the gaps gets the new version whole.
    documents.set('manager', { body: patterned(7 * SIZE, SIZE), etag: '"manual-v2"' })
    const changed = await app.fetch('/files/documents/manager', {
      headers: { range: 'bytes=100-199,600-699', 'if-range': etag },
    })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).toBe('"manual-v2"')
    await expectPatternedBody(changed, 7 * SIZE, SIZE)
  })

  it('serves a document viewer its trailer first, then the scattered pieces it needs, in the order it asks', async () => {
    const size = 64 * 1024
    documents.set('viewer', { body: patterned(0, size), etag: '"viewer-v1"' })

    const trailer = await app.fetch('/files/documents/viewer', { headers: { range: 'bytes=-1024' } })
    await expectRangeAnswer(trailer, { status: 206, start: size - 1024, end: size - 1 }, size)

    const pieces = await app.fetch('/files/documents/viewer', {
      headers: { range: 'bytes=40000-40999,1000-1999,63000-63999', 'if-range': '"viewer-v1"' },
    })
    await expectRangeAnswer(
      pieces,
      {
        status: 206,
        parts: [
          [40000, 40999],
          [1000, 1999],
          [63000, 63999],
        ],
      },
      size,
      PDF,
    )
  })

  it('lets a sync client download only the version it listed, and fetch again once it is told it changed', async () => {
    documents.set('sync', { body: BODY, etag: '"sync-v1"' })

    const listed = await app.fetch('/files/documents/sync', { headers: { 'if-match': '"sync-v1"' } })
    expect(listed.status).toBe(200)
    await expectPatternedBody(listed, 0, SIZE)

    documents.set('sync', { body: patterned(3 * SIZE, SIZE), etag: '"sync-v2"' })
    await expectPreconditionFailed(
      await app.fetch('/files/documents/sync', { headers: { 'if-match': '"sync-v1"' } }),
      'GET',
    )

    const fresh = await app.fetch('/files/documents/sync')
    expect(fresh.headers.get('etag')).toBe('"sync-v2"')
    await expectPatternedBody(fresh, 3 * SIZE, SIZE)
  })
})
