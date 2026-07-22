import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { accessTokenHash, assertAccessTokenHash } from './_at_hash.js'

/**
 * Base64url length of the left-most half of each digest: 16, 24 and 32 bytes respectively.
 * Pinning these pins the alg→digest mapping for every algorithm, not just the two the
 * example-based tests happen to exercise.
 */
const HALF_DIGEST_LENGTH: Record<string, number> = { 256: 22, 384: 32, 512: 43 }

const ALGS = ['RS256', 'ES256', 'PS256', 'RS384', 'ES384', 'PS384', 'RS512', 'ES512', 'PS512']
const algArb = fc.constantFrom(...ALGS)

describe('accessTokenHash (property)', () => {
  it.prop([fc.string(), algArb])('is deterministic', (token, alg) => {
    expect(accessTokenHash(token, alg)).toBe(accessTokenHash(token, alg))
  })

  it.prop([fc.string(), algArb])('has the length implied by the algorithm', (token, alg) => {
    expect(accessTokenHash(token, alg)).toHaveLength(HALF_DIGEST_LENGTH[alg.slice(-3)])
  })

  it.prop([fc.string(), algArb])('is base64url, so it is safe in a JWT claim', (token, alg) => {
    expect(accessTokenHash(token, alg)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it.prop([fc.string(), fc.string(), algArb])(
    'distinct tokens hash differently',
    (a, b, alg) => {
      fc.pre(a !== b)
      expect(accessTokenHash(a, alg)).not.toBe(accessTokenHash(b, alg))
    },
  )

  it.prop([fc.string()])('the three digest families disagree on the same token', token => {
    const hashes = new Set(['RS256', 'RS384', 'RS512'].map(alg => accessTokenHash(token, alg)))
    expect(hashes.size).toBe(3)
  })

  it.prop([fc.string(), fc.constantFrom('256', '384', '512')])(
    'algorithms sharing a digest size agree',
    (token, size) => {
      const [rs, es, ps] = [`RS${size}`, `ES${size}`, `PS${size}`].map(a => accessTokenHash(token, a))
      expect(es).toBe(rs)
      expect(ps).toBe(rs)
    },
  )
})

describe('assertAccessTokenHash (property)', () => {
  it.prop([fc.string(), algArb])('accepts the hash it just produced', (token, alg) => {
    expect(() => assertAccessTokenHash(token, accessTokenHash(token, alg), alg)).not.toThrow()
  })

  it.prop([fc.string(), fc.string(), algArb])(
    'rejects a hash computed over a different token',
    (a, b, alg) => {
      fc.pre(a !== b)
      expect(() => assertAccessTokenHash(a, accessTokenHash(b, alg), alg))
        .toThrow('at_hash does not match')
    },
  )

  it.prop([fc.string(), fc.constantFrom('256', '384', '512'), fc.constantFrom('256', '384', '512')])(
    'rejects a hash taken under a different digest size',
    (token, produced, verified) => {
      fc.pre(produced !== verified)
      expect(() => assertAccessTokenHash(token, accessTokenHash(token, `RS${produced}`), `RS${verified}`))
        .toThrow('at_hash does not match')
    },
  )

  it.prop([fc.string(), algArb, fc.string()])(
    'rejects any hash that is not the computed one',
    (token, alg, candidate) => {
      fc.pre(candidate !== accessTokenHash(token, alg))
      expect(() => assertAccessTokenHash(token, candidate, alg)).toThrow('at_hash does not match')
    },
  )
})
