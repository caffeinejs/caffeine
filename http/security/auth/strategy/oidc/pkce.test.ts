import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { generateCodeVerifier, generateCodeChallenge, selectPkceMethod } from './pkce.js'

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

describe('selectPkceMethod()', () => {
  it('defaults to S256 when supported is undefined', () => {
    expect(selectPkceMethod(undefined)).toBe('S256')
  })

  it('returns S256 when supported includes S256', () => {
    expect(selectPkceMethod(['S256', 'plain'])).toBe('S256')
    expect(selectPkceMethod(['S256'])).toBe('S256')
  })

  it('throws when only plain is supported and it is not explicitly allowed', () => {
    expect(() => selectPkceMethod(['plain'])).toThrow('enable allowPlainPkce')
  })

  it('returns plain when supported includes only plain and plain is allowed', () => {
    expect(selectPkceMethod(['plain'], true)).toBe('plain')
  })

  it('still prefers S256 when both are supported and plain is allowed', () => {
    expect(selectPkceMethod(['S256', 'plain'], true)).toBe('S256')
  })

  it('defaults to S256 when supported list is empty', () => {
    expect(selectPkceMethod([])).toBe('S256')
  })
})
