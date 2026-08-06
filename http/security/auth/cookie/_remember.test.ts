import { describe, it, expect } from 'vitest'
import { formatRemember, hashToken, newSeries, newToken, parseRemember, tokenMatches } from './_remember.js'

describe('remember-me helpers', () => {
  it('generates distinct, high-entropy series and tokens', () => {
    const a = newSeries()
    const b = newSeries()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(20)
    expect(newToken()).not.toBe(newToken())
    expect(newToken().length).toBeGreaterThanOrEqual(40)
  })

  it('hashes a token deterministically and not to the token itself', () => {
    const token = newToken()
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(token)
  })

  it('tokenMatches is true for the right token, false otherwise', () => {
    const token = newToken()
    const stored = hashToken(token)
    expect(tokenMatches(token, stored)).toBe(true)
    expect(tokenMatches(newToken(), stored)).toBe(false)
    expect(tokenMatches(token, 'not-a-hash')).toBe(false)
  })

  it('round-trips series:token', () => {
    const s = newSeries()
    const t = newToken()
    expect(parseRemember(formatRemember(s, t))).toEqual({ series: s, token: t })
  })

  it('keeps the token intact even when it contains no separator ambiguity', () => {
    // base64url never contains ':' so the first colon is always the true separator.
    const parsed = parseRemember('abc:def:ghi')
    expect(parsed).toEqual({ series: 'abc', token: 'def:ghi' })
  })

  it('rejects malformed remember cookies', () => {
    expect(parseRemember('noseparator')).toBeNull()
    expect(parseRemember(':leadingcolon')).toBeNull()
    expect(parseRemember('trailingcolon:')).toBeNull()
    expect(parseRemember('')).toBeNull()
  })
})
