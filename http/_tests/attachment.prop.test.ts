import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import { Attachment, Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import { expectRangeAnswer, extendedName, NAMED_DOWNLOAD, type RangeAnswer } from './bodies.js'
import { patterned } from './patterned.js'

/**
 * What a client gets back from an `Attachment`, over names and range headers no one wrote down, checked against
 * what RFC 9110 and RFC 8187 have a recipient read — not against how the adapter writes it.
 */

/** Spring's limit: a request for more ranges than this is answered whole (RFC 9110 §14.2: a server MAY ignore Range). */
const MOST_RANGES = 100

/**
 * The answer RFC 9110 §14 allows for one `Range` header against a body of `size` bytes, as this server serves
 * ranges: every satisfiable byte range of a body that has bytes, in the order asked for, and every other request
 * answered whole (§14.2: a server MAY ignore Range).
 */
function rangeModel(header: string, size: number): RangeAnswer {
  if (size === 0) {
    return { status: 200 }
  }

  const equals = header.indexOf('=')
  // §14.1: the range unit is compared without regard to case; a unit this server does not serve is ignored.
  if (equals === -1 || header.slice(0, equals).toLowerCase() !== 'bytes') {
    return { status: 200 }
  }

  // §5.6.1: a recipient accepts empty list elements; §14.1.1: a ranges-specifier holds at least one range.
  const specs = header
    .slice(equals + 1)
    .split(',')
    .map(spec => spec.trim())
    .filter(spec => spec !== '')
  if (specs.length === 0 || specs.length > MOST_RANGES) {
    return { status: 200 }
  }

  const satisfiable: Array<[number, number]> = []
  for (const spec of specs) {
    const int = /^(\d+)-(\d*)$/.exec(spec)
    const suffix = /^-(\d+)$/.exec(spec)

    if (int !== null) {
      const first = Number(int[1])
      const last = int[2] === '' ? Number.POSITIVE_INFINITY : Number(int[2])

      // §14.1.1: an int-range whose last-pos is below its first-pos is invalid, and so is the header holding it.
      if (last < first) {
        return { status: 200 }
      }

      // §14.1.1: satisfiable only when first-pos is inside the body; a last-pos past the end means the end.
      if (first < size) {
        satisfiable.push([first, Math.min(last, size - 1)])
      }
    } else if (suffix !== null) {
      // §14.1.1: a suffix-range is satisfiable only with a non-zero suffix-length; one longer than the body is all
      // of it.
      const length = Number(suffix[1])
      if (length > 0) {
        satisfiable.push([Math.max(size - length, 0), size - 1])
      }
    } else {
      return { status: 200 }
    }
  }

  // §15.5.17: not one of them satisfiable.
  if (satisfiable.length === 0) {
    return { status: 416 }
  }

  // Ranges adding up to more than the body are a broken client or an attack (§14.2), answered whole as Go does.
  if (satisfiable.reduce((sum, [first, last]) => sum + last - first + 1, 0) > size) {
    return { status: 200 }
  }

  // §15.3.7.2: one range is a single part, never multipart; several go in the order asked for.
  if (satisfiable.length === 1) {
    const [[start, end]] = satisfiable
    return { status: 206, start, end }
  }

  return { status: 206, parts: satisfiable }
}

const CONDITIONAL_SIZE = 1000
const MODIFIED = new Date('2026-10-01T12:34:56.789Z')
const CURRENT = '"report-v1"'
// What a request carries as an entity tag: the current one, its weak form, another, one holding a comma, and a value
// that is not an entity tag at all for being unquoted.
const TAGS = [CURRENT, 'W/"report-v1"', '"report-v2"', '"v0,v1"', 'report-v1'] as const
type Tag = (typeof TAGS)[number]
// A date a request carries, against the content's Last-Modified: a second before it, the same second, a minute
// after; one that does not parse, and one a lenient parser would read as a date but that is no HTTP-date (§5.6.7).
type DateKind = 'earlier' | 'equal' | 'later' | 'invalid' | 'loose'
const DATES: Record<DateKind, string> = {
  earlier: new Date(MODIFIED.getTime() - 1000).toUTCString(),
  equal: MODIFIED.toUTCString(),
  later: new Date(MODIFIED.getTime() + 60_000).toUTCString(),
  invalid: 'yesterday',
  loose: '2026',
}

interface Content {
  etag?: string
  lastModified?: Date
}

interface Conditional {
  method: 'GET' | 'HEAD'
  ifMatch?: '*' | Tag[]
  ifUnmodifiedSince?: DateKind
  ifNoneMatch?: '*' | Tag[]
  ifModifiedSince?: DateKind
  range?: string
  ifRange?: { tag: Tag } | { date: DateKind }
}

type ConditionalAnswer = RangeAnswer | { status: 304 } | { status: 412 }

// §8.8.3.2: strong comparison, both tags strong and the same.
const strongMatch = (tag: Tag, etag: string | undefined) =>
  etag !== undefined && tag !== 'report-v1' && !tag.startsWith('W/') && !etag.startsWith('W/') && tag === etag

// §8.8.3.2: weak comparison, the same opaque tag whatever either says of strength.
const weakMatch = (tag: Tag, etag: string | undefined) =>
  etag !== undefined && tag !== 'report-v1' && tag.replace(/^W\//, '') === etag.replace(/^W\//, '')

/**
 * The answer RFC 9110 §13.2.2 has an origin server give a GET or HEAD for the content, taking the steps in its order:
 * If-Match, else If-Unmodified-Since; then If-None-Match, else If-Modified-Since; then Range under If-Range.
 */
function conditionalModel(content: Content, request: Conditional, size: number): ConditionalAnswer {
  // Step 1, §13.1.1: `*` holds while there is a representation; a list holds when one tag matches strongly.
  if (request.ifMatch !== undefined) {
    if (request.ifMatch !== '*' && !request.ifMatch.some(tag => strongMatch(tag, content.etag))) {
      return { status: 412 }
    }
  } else if (request.ifUnmodifiedSince !== undefined) {
    // Step 2, §13.1.4: false when the content changed after the date; an invalid date, or content with no date,
    // is ignored.
    if (request.ifUnmodifiedSince === 'earlier' && content.lastModified !== undefined) {
      return { status: 412 }
    }
  }

  // Step 3, §13.1.2: false, for a GET or HEAD a 304, when `*` meets a representation or a tag matches weakly.
  if (request.ifNoneMatch !== undefined) {
    if (request.ifNoneMatch === '*' || request.ifNoneMatch.some(tag => weakMatch(tag, content.etag))) {
      return { status: 304 }
    }
  } else if (request.ifModifiedSince !== undefined) {
    // Step 4, §13.1.3: false when the content has not changed since a valid date.
    const kind = request.ifModifiedSince
    if ((kind === 'equal' || kind === 'later') && content.lastModified !== undefined) {
      return { status: 304 }
    }
  }

  // Step 5, §13.1.5: a GET's Range is served while If-Range holds: a strong tag strongly matching, or the very
  // Last-Modified date.
  const ifRange = request.ifRange
  const ifRangeHolds =
    ifRange === undefined ||
    ('tag' in ifRange
      ? strongMatch(ifRange.tag, content.etag)
      : ifRange.date === 'equal' && content.lastModified !== undefined)
  if (request.method === 'GET' && request.range !== undefined && ifRangeHolds) {
    return rangeModel(request.range, size)
  }

  return { status: 200 }
}

/**
 * The file name RFC 6266 has a client given `name` save: its last `/` or `\\` segment, without control characters or
 * the marks that reorder how it reads. `undefined` when nothing is left a file could be named.
 */
function savedName(name: string): string | undefined {
  const last = name.toWellFormed().split(/[/\\]/).at(-1)!
  const saved = last.replaceAll(/[\p{Cc}\p{Bidi_Control}\uFEFF]/gu, '')

  return saved === '' || saved === '.' || saved === '..' ? undefined : saved
}

// Each case is kept under its own id and named in the request, so cases that ever ran at once would not cross.
const cases = new Map<number, { name?: string; size?: number; kind?: 'blob' | 'bytes'; content?: Content }>()
let nextID = 0

function caseOf(value: { name?: string; size?: number; kind?: 'blob' | 'bytes'; content?: Content }): number {
  const id = nextID++
  cases.set(id, value)
  return id
}

const routes = new Router('/prop')
routes
  .get('/named/:id')
  .handler(ctx => Attachment(new Blob(['x']), { name: cases.get(Number(ctx.req.param().id))!.name }))
routes.get('/sized/:id').handler(ctx => {
  const { size, kind } = cases.get(Number(ctx.req.param().id))!
  const body = patterned(0, size!)
  return Attachment(kind === 'blob' ? new Blob([body]) : body)
})
routes.get('/conditional/:id').handler(ctx => {
  const { content } = cases.get(Number(ctx.req.param().id))!
  return Attachment(patterned(0, CONDITIONAL_SIZE), content)
})

const app = createWebApplication().mount(routes)

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

const position = fc.oneof(fc.nat({ max: 3200 }), fc.constantFrom(0, 1, 2 ** 53, 10 ** 20))
const rangeSpec = fc.oneof(
  fc.tuple(position, fc.option(position, { nil: undefined })).map(([first, last]) => `${first}-${last ?? ''}`),
  position.map(length => `-${length}`),
  fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 })).map(([a, b]) => `${String(a).padStart(4, '0')}-${b}`),
  fc.stringMatching(/^[0-9a-z ,=-]{0,8}$/),
)
const rangeHeader = fc
  .tuple(
    fc.constantFrom('bytes', 'Bytes', 'BYTES', 'items', ''),
    fc.constantFrom('=', '', ' ='),
    fc.array(rangeSpec, { minLength: 1, maxLength: 4 }),
    fc.constantFrom(',', ', ', ' ,'),
  )
  .map(([unit, equals, specs, separator]) => `${unit}${equals}${specs.join(separator)}`)

// Lone surrogates, separators and reordering marks included: a name built from bad input still has to be written as
// a header, and as a plain file name.
const anyName = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc
    .array(fc.constantFrom('a', '.', '..', '/', '\\', '\u0000', '\r\n', '\u202E', '\u2066', '\uFEFF', 'é', ' '), {
      maxLength: 8,
    })
    .map(parts => parts.join('')),
  fc.constantFrom('\uD800', 'a\uDC00b', 'tab\there', 'nul\u0000', 'del\u007f', '"\\"', '%E9', "'*()", '../x', 'C:\\x'),
)

describe('Attachment() over any name (property)', () => {
  it.prop([anyName], { numRuns: 300 })(
    'writes a header of visible ASCII naming one plain file, or no file when nothing could be named',
    async name => {
      const res = await app.fetch(`/prop/named/${caseOf({ name })}`)
      const disposition = res.headers.get('content-disposition')!
      const saved = savedName(name)

      expect(res.status).toBe(200)
      if (saved === undefined) {
        expect(disposition).toBe('attachment')
        return
      }

      expect(disposition).toMatch(NAMED_DOWNLOAD)
      const decoded = extendedName(disposition)!
      expect(decoded).toBe(saved)
      expect(decoded).not.toMatch(/[/\\\p{Cc}\p{Bidi_Control}\uFEFF]/u)
    },
  )
})

describe('Attachment() over any range (property)', () => {
  it.prop([fc.nat({ max: 3000 }), fc.constantFrom('blob', 'bytes'), rangeHeader], { numRuns: 400 })(
    'answers with exactly what RFC 9110 has a server answer, and never with bytes its headers do not describe',
    async (nextSize, nextKind, range) => {
      const res = await app.fetch(`/prop/sized/${caseOf({ size: nextSize, kind: nextKind })}`, { headers: { range } })

      expect(res.headers.get('accept-ranges')).toBe('bytes')
      // RFC 9110 §5.5: a field value arrives without the whitespace around it.
      await expectRangeAnswer(res, rangeModel(range.trim(), nextSize), nextSize)
    },
  )
})

const tagList = fc.oneof(fc.constant('*' as const), fc.array(fc.constantFrom(...TAGS), { minLength: 1, maxLength: 3 }))
const dateKind = fc.constantFrom<DateKind>('earlier', 'equal', 'later', 'invalid', 'loose')
const content: fc.Arbitrary<Content> = fc.record({
  etag: fc.constantFrom(CURRENT, 'W/"report-v1"', undefined),
  lastModified: fc.constantFrom(MODIFIED, undefined),
})
const conditional: fc.Arbitrary<Conditional> = fc.record({
  method: fc.constantFrom<'GET' | 'HEAD'>('GET', 'HEAD'),
  ifMatch: fc.option(tagList, { nil: undefined }),
  ifUnmodifiedSince: fc.option(dateKind, { nil: undefined }),
  ifNoneMatch: fc.option(tagList, { nil: undefined }),
  ifModifiedSince: fc.option(dateKind, { nil: undefined }),
  range: fc.option(
    fc.constantFrom('bytes=10-19', 'bytes=10-19,30-39', 'bytes=0-4,2000-', 'bytes=2000-', 'bytes=5-2', 'items=0-4'),
    { nil: undefined },
  ),
  ifRange: fc.option(
    fc.oneof(
      fc.constantFrom(...TAGS).map(tag => ({ tag })),
      dateKind.map(date => ({ date })),
    ),
    { nil: undefined },
  ),
})

/** The request's header fields, written as a client writes them. */
function headersOf(request: Conditional): Record<string, string> {
  const list = (value: '*' | Tag[]) => (value === '*' ? '*' : value.join(', '))
  const headers: Record<string, string> = {}

  if (request.ifMatch !== undefined) {
    headers['if-match'] = list(request.ifMatch)
  }
  if (request.ifUnmodifiedSince !== undefined) {
    headers['if-unmodified-since'] = DATES[request.ifUnmodifiedSince]
  }
  if (request.ifNoneMatch !== undefined) {
    headers['if-none-match'] = list(request.ifNoneMatch)
  }
  if (request.ifModifiedSince !== undefined) {
    headers['if-modified-since'] = DATES[request.ifModifiedSince]
  }
  if (request.range !== undefined) {
    headers.range = request.range
  }
  if (request.ifRange !== undefined) {
    headers['if-range'] = 'tag' in request.ifRange ? request.ifRange.tag : DATES[request.ifRange.date]
  }

  return headers
}

describe('Attachment() over any combination of preconditions (property)', () => {
  it.prop([content, conditional], { numRuns: 400 })(
    'answers what RFC 9110 §13.2.2 has an origin server answer, taking its steps in order',
    async (content, request) => {
      const res = await app.fetch(`/prop/conditional/${caseOf({ content })}`, {
        method: request.method,
        headers: headersOf(request),
      })
      const expected = conditionalModel(content, request, CONDITIONAL_SIZE)

      expect(res.status).toBe(expected.status)
      if (expected.status === 412 && request.method === 'GET') {
        expect(await res.json()).toMatchObject({ statusCode: 412, code: 'ERR_HTTP_PRECONDITION_FAILED' })
      } else if (expected.status === 412 || expected.status === 304 || request.method === 'HEAD') {
        expect(await res.text()).toBe('')
      } else {
        await expectRangeAnswer(res, expected, CONDITIONAL_SIZE)
      }
    },
  )
})
