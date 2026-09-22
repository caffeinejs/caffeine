import type { AdapterRequest } from '@caffeinejs/http'
import { it, fc } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { defaultCacheKey, generateETag, matchesETag } from './_util.js'

// An arbitrary entity-tag as RFC 9110 §8.8.3 writes one: double-quoted, no quote inside, no leading W/ (covered
// separately). A comma inside is legal, which is why a list is scanned for tags and never cut on commas.
const etagToken = fc
  .string({ minLength: 1 })
  .filter(s => !s.includes('"'))
  .map(s => `"${s}"`)

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

  it.prop([fc.string(), fc.string()])('distinct string inputs produce distinct ETags', async (a, b) => {
    fc.pre(a !== b)
    expect(await generateETag(a)).not.toBe(await generateETag(b))
  })
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

  it.prop([fc.array(etagToken, { minLength: 1 }), etagToken])(
    'stored ETag absent from comma-separated list returns false',
    (tags, stored) => {
      fc.pre(!tags.includes(stored))
      expect(matchesETag(tags.join(', '), stored)).toBe(false)
    },
  )

  // The tag looked for comes last, behind a separator that always has whitespace on both sides: a comparison
  // that trimmed nothing would not find it.
  it.prop([
    etagToken,
    fc.array(etagToken, { minLength: 1, maxLength: 3 }),
    fc.integer({ min: 1, max: 4 }).map(n => ' '.repeat(n)),
  ])('whitespace around comma separators is trimmed', (stored, others, spaces) => {
    const list = [...others, stored].join(`${spaces},${spaces}`)
    expect(matchesETag(list, stored)).toBe(true)
  })
})

// Query keys are unique: a repeated key's values keep their relative order through canonicalization, so
// `?a=1&a=2` and `?a=2&a=1` are different requests and must stay different keys.
const pathWithQuery = fc
  .tuple(
    fc.array(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { maxLength: 4 }).map(segments => `/${segments.join('/')}`),
    fc.uniqueArray(fc.tuple(fc.string({ minLength: 1 }), fc.string()), { selector: ([k]) => k, maxLength: 5 }),
  )
  .chain(([path, params]) =>
    fc.tuple(
      fc.constant(path),
      fc.constant(params),
      fc.shuffledSubarray(params, { minLength: params.length, maxLength: params.length }),
    ),
  )

function withQuery(path: string, params: [string, string][]): string {
  if (params.length === 0) {
    return path
  }

  return `${path}?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
}

describe('defaultCacheKey (property)', () => {
  const asRequest = (method: string, url: string) => ({ method, url, headers: {} }) as unknown as AdapterRequest

  it.prop([pathWithQuery, fc.constantFrom('GET', 'HEAD')])(
    'gives a GET and a HEAD one key, whatever order the query arrived in',
    ([path, params, shuffled], method) => {
      expect(defaultCacheKey(asRequest(method, withQuery(path, shuffled)))).toBe(
        defaultCacheKey(asRequest('GET', withQuery(path, params))),
      )
    },
  )

  // A parameter outside the allow-list, wherever it sits and whatever it holds, changes nothing about the key;
  // the ones inside still count, in any order.
  it.prop([pathWithQuery, fc.array(fc.tuple(fc.stringMatching(/^x-[a-z]{1,6}$/), fc.string()), { maxLength: 3 })])(
    'leaves the key unchanged by any parameter outside varyByQuery',
    ([path, params, shuffled], extra) => {
      const named = new Set(params.map(([k]) => k))
      fc.pre(!extra.some(([k]) => named.has(k)))
      const withExtra = [...shuffled.slice(0, 1), ...extra, ...shuffled.slice(1)] as [string, string][]

      expect(defaultCacheKey(asRequest('GET', withQuery(path, withExtra)), undefined, named)).toBe(
        defaultCacheKey(asRequest('GET', withQuery(path, params)), undefined, named),
      )
    },
  )
})
