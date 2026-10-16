import { createHash } from 'node:crypto'

import { describe, it, expect } from 'vitest'

import { generateCodeVerifier, generateCodeChallenge, selectPKCEMethod } from './pkce.js'

describe('generateCodeVerifier()', () => {
  it('returns a 43-character base64url string', () => {
    const verifier = generateCodeVerifier()
    expect(verifier).toHaveLength(43)
  })

  it('contains only base64url characters', () => {
    const verifier = generateCodeVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns different values on each call', () => {
    const a = generateCodeVerifier()
    const b = generateCodeVerifier()
    expect(a).not.toBe(b)
  })
})

describe('generateCodeChallenge()', () => {
  it('returns sha256 of verifier base64url-encoded', () => {
    const verifier = generateCodeVerifier()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(generateCodeChallenge(verifier)).toBe(expected)
  })

  it('returns only base64url characters', () => {
    const challenge = generateCodeChallenge(generateCodeVerifier())
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('selectPKCEMethod()', () => {
  it('defaults to S256 when supported is undefined', () => {
    expect(selectPKCEMethod(undefined)).toBe('S256')
  })

  it('returns S256 when supported includes S256', () => {
    expect(selectPKCEMethod(['S256', 'plain'])).toBe('S256')
    expect(selectPKCEMethod(['S256'])).toBe('S256')
  })

  it('throws when only plain is supported and it is not explicitly allowed', () => {
    expect(() => selectPKCEMethod(['plain'])).toThrow('enable allowPlainPKCE')
  })

  it('returns plain when supported includes only plain and plain is allowed', () => {
    expect(selectPKCEMethod(['plain'], true)).toBe('plain')
  })

  it('still prefers S256 when both are supported and plain is allowed', () => {
    expect(selectPKCEMethod(['S256', 'plain'], true)).toBe('S256')
  })

  // A published list that contains neither method is the provider saying it supports no PKCE
  // we can use. Sending S256 anyway invites it to ignore `code_challenge` and drop PKCE from
  // the flow silently, so refusing to start is the safer failure.
  it('throws when the supported list is empty', () => {
    expect(() => selectPKCEMethod([])).toThrow('advertises no supported PKCE method')
  })

  it('throws when the supported list names only unknown methods', () => {
    expect(() => selectPKCEMethod(['S512'])).toThrow('advertises no supported PKCE method')
  })

  // Absent is different from empty: it means the provider published no opinion, and OIDC
  // Discovery leaves S256 available.
  it('defaults to S256 when discovery omits the field', () => {
    expect(selectPKCEMethod(undefined)).toBe('S256')
  })
})
