import { describe, expect, it } from 'vitest'
import { parseAuthorizationHeader } from './authorization_header.js'

describe('parseAuthorizationHeader', () => {
  it('extracts the credentials for a matching scheme', () => {
    expect(parseAuthorizationHeader('Bearer abc.def.ghi', 'Bearer')).toBe('abc.def.ghi')
  })

  // RFC 7235 §2.1 makes the scheme token case-insensitive, and real clients send every casing. A
  // case-sensitive match rejected these as though no credential had been offered at all.
  it.each(['bearer abc', 'BEARER abc', 'BeArEr abc'])('matches the scheme case-insensitively: %s', header => {
    expect(parseAuthorizationHeader(header, 'Bearer')).toBe('abc')
  })

  it('matches a case-insensitively configured scheme too', () => {
    expect(parseAuthorizationHeader('Bearer abc', 'bearer')).toBe('abc')
  })

  it('returns undefined for a different scheme', () => {
    expect(parseAuthorizationHeader('Basic dXNlcjpwdw==', 'Bearer')).toBeUndefined()
  })

  it('does not treat a scheme prefix as a match', () => {
    // `BearerToken` is a different scheme, not `Bearer` with credentials `Token`.
    expect(parseAuthorizationHeader('BearerToken abc', 'Bearer')).toBeUndefined()
  })

  it('returns undefined for an absent header', () => {
    expect(parseAuthorizationHeader(undefined, 'Bearer')).toBeUndefined()
  })

  it('returns undefined for a scheme with no credentials', () => {
    expect(parseAuthorizationHeader('Bearer', 'Bearer')).toBeUndefined()
    expect(parseAuthorizationHeader('Bearer ', 'Bearer')).toBeUndefined()
    expect(parseAuthorizationHeader('Bearer    ', 'Bearer')).toBeUndefined()
  })

  it('trims surrounding whitespace from the credentials', () => {
    expect(parseAuthorizationHeader('Bearer  abc  ', 'Bearer')).toBe('abc')
  })
})
