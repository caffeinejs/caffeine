import { FastifyContextRequest, type AdapterRequest } from '@caffeinejs/http'
import { it, fc } from '@fast-check/vitest'
import type { FastifyRequest } from 'fastify'
import { describe, expect } from 'vitest'

import { defaultCacheKey, generateETag, matchesETag, pathCacheKey } from './_util.js'
import { cacheKey } from './cache_key.js'

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

  it.prop([etagToken, fc.array(etagToken, { maxLength: 3 }), fc.integer({ min: 0, max: 4 }).map(n => ' '.repeat(n))])(
    'whitespace around comma separators is trimmed',
    (stored, others, spaces) => {
      const list = [stored, ...others].join(`,${spaces}`)
      expect(matchesETag(list, stored)).toBe(true)
    },
  )
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

describe('pathCacheKey (property)', () => {
  // Invalidation by path deletes `pathCacheKey(path)`; the cache stored the entry under `defaultCacheKey`. If the
  // two ever disagree, `@CacheInvalidate({ paths })` reports success and evicts nothing.
  it.prop([pathWithQuery, fc.constantFrom('GET', 'HEAD')])(
    'matches the key a GET or HEAD stored, whatever order the query arrived in',
    ([path, params, shuffled], method) => {
      const request = { method, url: withQuery(path, shuffled), headers: {} } as unknown as AdapterRequest

      expect(pathCacheKey(withQuery(path, params))).toBe(defaultCacheKey(request))
    },
  )
})

describe('cacheKey (property)', () => {
  const asRequest = (method: string, url: string, headers: Record<string, string> = {}) =>
    ({ method, url, headers }) as unknown as AdapterRequest

  const wrap = (request: AdapterRequest) => new FastifyContextRequest(request as unknown as FastifyRequest)

  // The helper exists to name an entry from another request. If it ever derives a key the cache would not have
  // stored, an eviction written with it reports success and evicts nothing.
  it.prop([pathWithQuery, fc.constantFrom('GET', 'HEAD', 'POST')])(
    'is the key the cache stores for the same request',
    ([path, , shuffled], method) => {
      const request = asRequest(method, withQuery(path, shuffled))

      expect(cacheKey(wrap(request))).toBe(defaultCacheKey(request))
    },
  )

  it.prop([pathWithQuery, fc.constantFrom('PUT', 'POST', 'DELETE', 'PATCH')])(
    'names, from a mutating request, the entry a GET stored on that URL or on another',
    ([path, params, shuffled], method) => {
      const mutation = wrap(asRequest(method, withQuery(path, shuffled)))

      expect(cacheKey(mutation, { method: 'get' })).toBe(pathCacheKey(withQuery(path, params)))
      expect(cacheKey(wrap(asRequest(method, '/elsewhere')), { method: 'GET', url: withQuery(path, params) })).toBe(
        pathCacheKey(withQuery(path, shuffled)),
      )
    },
  )

  it.prop([pathWithQuery, fc.string(), fc.string()])(
    'names one variant of a varying route, from header values it is given',
    ([path, params], language, other) => {
      const stored = asRequest('GET', withQuery(path, params), { 'accept-language': language })
      const mutation = wrap(asRequest('POST', '/publish', { 'accept-language': other }))

      expect(
        cacheKey(mutation, {
          method: 'GET',
          url: withQuery(path, params),
          vary: ['Accept-Language'],
          headers: { 'accept-language': language },
        }),
      ).toBe(defaultCacheKey(stored, ['Accept-Language']))
    },
  )
})
