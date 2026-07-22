import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { accessTokenHash, assertAccessTokenHash } from './_at_hash.js'

// OpenID Connect Core 1.0, Appendix A.3 — the specification's own at_hash example.
const SPEC_ACCESS_TOKEN = 'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y'
const SPEC_AT_HASH = '77QmUPtjPfzWtF2AnpK9RQ'

/** Independent reference implementation, so the test does not reuse the code under test. */
function referenceHash(token: string, digest: string): string {
  const bytes = createHash(digest).update(token, 'ascii').digest()
  return bytes.subarray(0, bytes.length / 2).toString('base64url')
}

describe('accessTokenHash()', () => {
  it('matches the OIDC Core Appendix A.3 vector for RS256', () => {
    expect(accessTokenHash(SPEC_ACCESS_TOKEN, 'RS256')).toBe(SPEC_AT_HASH)
  })

  it('uses sha256 for the 256-bit algorithms', () => {
    for (const alg of ['RS256', 'ES256', 'PS256']) {
      expect(accessTokenHash('token', alg)).toBe(referenceHash('token', 'sha256'))
    }
  })

  it('uses sha384 for the 384-bit algorithms', () => {
    for (const alg of ['RS384', 'ES384', 'PS384']) {
      expect(accessTokenHash('token', alg)).toBe(referenceHash('token', 'sha384'))
    }
  })

  it('uses sha512 for the 512-bit algorithms', () => {
    for (const alg of ['RS512', 'ES512', 'PS512']) {
      expect(accessTokenHash('token', alg)).toBe(referenceHash('token', 'sha512'))
    }
  })

  it('produces a different hash per digest size', () => {
    const s256 = accessTokenHash('token', 'RS256')
    const s384 = accessTokenHash('token', 'RS384')
    const s512 = accessTokenHash('token', 'RS512')
    expect(new Set([s256, s384, s512]).size).toBe(3)
  })
})

describe('assertAccessTokenHash()', () => {
  it('accepts a matching hash', () => {
    expect(() => assertAccessTokenHash(SPEC_ACCESS_TOKEN, SPEC_AT_HASH, 'RS256')).not.toThrow()
  })

  it('rejects a hash computed over a different token', () => {
    const wrong = accessTokenHash('another-access-token', 'RS256')
    expect(() => assertAccessTokenHash(SPEC_ACCESS_TOKEN, wrong, 'RS256'))
      .toThrow('at_hash does not match the access token')
  })

  it('rejects a hash of the right token under the wrong algorithm', () => {
    const wrongAlg = accessTokenHash(SPEC_ACCESS_TOKEN, 'RS512')
    expect(() => assertAccessTokenHash(SPEC_ACCESS_TOKEN, wrongAlg, 'RS256'))
      .toThrow('at_hash does not match the access token')
  })

  it('rejects a truncated hash without throwing on the length mismatch', () => {
    expect(() => assertAccessTokenHash(SPEC_ACCESS_TOKEN, SPEC_AT_HASH.slice(0, -1), 'RS256'))
      .toThrow('at_hash does not match the access token')
  })
})
