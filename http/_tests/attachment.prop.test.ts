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

/**
 * The answer RFC 9110 §14 allows for one `Range` header against a body of `size` bytes, as this server serves
 * ranges: one byte range of a body that has bytes, every other request answered whole (§14.2: a server MAY
 * ignore Range).
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

  // §5.6.1: a recipient accepts empty list elements. More than one range is served whole.
  const specs = header
    .slice(equals + 1)
    .split(',')
    .map(spec => spec.trim())
    .filter(spec => spec !== '')
  if (specs.length !== 1) {
    return { status: 200 }
  }

  const int = /^(\d+)-(\d*)$/.exec(specs[0])
  if (int !== null) {
    const first = Number(int[1])
    const last = int[2] === '' ? Number.POSITIVE_INFINITY : Number(int[2])

    // §14.1.1: an int-range whose last-pos is below its first-pos is invalid, and an invalid range is ignored.
    if (last < first) {
      return { status: 200 }
    }

    // §14.1.1: satisfiable only when first-pos is inside the body; §15.5.17: otherwise 416.
    if (first >= size) {
      return { status: 416 }
    }

    // §14.1.1: a last-pos past the end means the end.
    return { status: 206, start: first, end: Math.min(last, size - 1) }
  }

  const suffix = /^-(\d+)$/.exec(specs[0])
  if (suffix !== null) {
    const length = Number(suffix[1])

    // §14.1.1: a suffix-range is satisfiable only with a non-zero suffix-length; one longer than the body is all of it.
    return length === 0 ? { status: 416 } : { status: 206, start: Math.max(size - length, 0), end: size - 1 }
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
const cases = new Map<number, { name?: string; size?: number; kind?: 'blob' | 'bytes' }>()
let nextID = 0

function caseOf(value: { name?: string; size?: number; kind?: 'blob' | 'bytes' }): number {
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
    fc.array(rangeSpec, { minLength: 1, maxLength: 3 }),
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
