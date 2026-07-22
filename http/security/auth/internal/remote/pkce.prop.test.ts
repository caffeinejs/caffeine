import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { generateCodeChallenge, generateCodeVerifier, selectPkceMethod } from './pkce.js'

/** RFC 7636 §4.1: the verifier is 43-128 characters from the unreserved set. */
const UNRESERVED_43 = /^[A-Za-z0-9_-]{43}$/

describe('generateCodeVerifier (property)', () => {
  it.prop([fc.integer({ min: 0, max: 50 })])('always yields 43 unreserved characters', () => {
    expect(generateCodeVerifier()).toMatch(UNRESERVED_43)
  })

  it.prop([fc.integer({ min: 2, max: 25 })])('yields a distinct value on every call', n => {
    const seen = new Set(Array.from({ length: n }, () => generateCodeVerifier()))
    expect(seen.size).toBe(n)
  })
})

describe('generateCodeChallenge (property)', () => {
  it.prop([fc.string()])('is deterministic', verifier => {
    expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier))
  })

  it.prop([fc.string()])('is a base64url SHA-256 digest, whatever the input', verifier => {
    expect(generateCodeChallenge(verifier)).toMatch(UNRESERVED_43)
  })

  it.prop([fc.string(), fc.string()])('distinct verifiers give distinct challenges', (a, b) => {
    fc.pre(a !== b)
    expect(generateCodeChallenge(a)).not.toBe(generateCodeChallenge(b))
  })

  it.prop([fc.string()])('never returns the verifier itself, which would be plain', verifier => {
    expect(generateCodeChallenge(verifier)).not.toBe(verifier)
  })
})

describe('selectPkceMethod (property)', () => {
  const noise = fc.array(fc.string().filter(s => s !== 'S256' && s !== 'plain'), { maxLength: 4 })

  it.prop([noise, noise, fc.boolean()])(
    'prefers S256 wherever it appears in the advertised list',
    (before, after, allowPlain) => {
      expect(selectPkceMethod([...before, 'S256', ...after], allowPlain)).toBe('S256')
      // plain being offered alongside must never downgrade the choice
      expect(selectPkceMethod([...before, 'plain', 'S256', ...after], allowPlain)).toBe('S256')
    },
  )

  it.prop([noise, noise])('rejects a plain-only provider by default', (before, after) => {
    expect(() => selectPkceMethod([...before, 'plain', ...after]))
      .toThrow('enable allowPlainPkce')
  })

  it.prop([noise, noise])('accepts a plain-only provider when opted in', (before, after) => {
    expect(selectPkceMethod([...before, 'plain', ...after], true)).toBe('plain')
  })

  it.prop([noise, fc.boolean()])(
    'throws when a published list advertises neither method',
    (supported, allowPlain) => {
      expect(() => selectPkceMethod(supported, allowPlain))
        .toThrow('advertises no supported PKCE method')
    },
  )

  it.prop([fc.boolean()])('falls back to S256 when discovery says nothing', allowPlain => {
    expect(selectPkceMethod(undefined, allowPlain)).toBe('S256')
  })
})
