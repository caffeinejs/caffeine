import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { generateETag, matchesETag } from './_util.js'

// Arbitrary ETag token: no commas (would be parsed as list delimiter), no leading W/ (covered separately)
// matchesETag trims ifNoneMatch entries after splitting but not the stored ETag, so a stored
// value with leading/trailing whitespace would never match itself in a list context.
// Restricting to trimmed strings keeps properties about list membership meaningful.
const etagToken = fc.string({ minLength: 1 }).filter(
  s => s === s.trim() && !s.includes(',') && !s.startsWith('W/') && s !== '*',
)

describe('generateETag (property)', () => {
  const anyPayload = fc.oneof(
    fc.string(), // printable ASCII (default: grapheme-ascii)
    fc.string({ unit: 'grapheme' }), // full Unicode incl. supplementary planes
    fc.string({ unit: 'grapheme-composite' }), // composite graphemes (emoji sequences etc.)
    fc.string({ unit: 'binary' }), // arbitrary byte values as string chars
    fc.uint8Array().map(a => Buffer.from(a)), // arbitrary binary bytes as Buffer
  )

  it.prop([anyPayload])('result is a quoted 16-hex-char string', async payload => {
    expect(await generateETag(payload as string | Buffer)).toMatch(/^"[0-9a-f]{16}"$/)
  })

  it.prop([anyPayload])('deterministic: same input produces same ETag', async payload => {
    const cast = payload as string | Buffer
    expect(await generateETag(cast)).toBe(await generateETag(cast))
  })

  it.prop([fc.string()])('string and Buffer of same content produce the same ETag', async s => {
    expect(await generateETag(s)).toBe(await generateETag(Buffer.from(s)))
  })

  it.prop([fc.string(), fc.string()])(
    'distinct string inputs produce distinct ETags',
    async (a, b) => {
      fc.pre(a !== b)
      expect(await generateETag(a)).not.toBe(await generateETag(b))
    },
  )
})

describe('matchesETag (property)', () => {
  it.prop([fc.string()])('wildcard ifNoneMatch matches any stored ETag', stored => {
    expect(matchesETag('*', stored)).toBe(true)
  })

  it.prop([etagToken])('a tag matches itself (reflexive)', tag => {
    expect(matchesETag(tag, tag)).toBe(true)
  })

  it.prop([etagToken])('W/ prefix on stored ETag is stripped before comparison', tag => {
    expect(matchesETag(tag, `W/${tag}`)).toBe(true)
  })

  it.prop([etagToken])('W/ prefix on ifNoneMatch is stripped before comparison', tag => {
    expect(matchesETag(`W/${tag}`, tag)).toBe(true)
  })

  it.prop([etagToken])('matching W/ tags on both sides are equal', tag => {
    expect(matchesETag(`W/${tag}`, `W/${tag}`)).toBe(true)
  })

  it.prop([fc.array(etagToken, { minLength: 1 }), fc.nat()])(
    'stored ETag present in comma-separated list returns true',
    (tags, indexRaw) => {
      const idx = indexRaw % tags.length
      expect(matchesETag(tags.join(', '), tags[idx])).toBe(true)
    },
  )

  it.prop([
    fc.array(etagToken, { minLength: 1 }),
    etagToken,
  ])(
    'stored ETag absent from comma-separated list returns false',
    (tags, stored) => {
      fc.pre(!tags.includes(stored))
      expect(matchesETag(tags.join(', '), stored)).toBe(false)
    },
  )

  it.prop([
    etagToken,
    fc.array(etagToken, { maxLength: 3 }),
    fc.integer({ min: 0, max: 4 }).map(n => ' '.repeat(n)),
  ])(
    'whitespace around comma separators is trimmed',
    (stored, others, spaces) => {
      const list = [stored, ...others].join(`,${spaces}`)
      expect(matchesETag(list, stored)).toBe(true)
    },
  )
})
