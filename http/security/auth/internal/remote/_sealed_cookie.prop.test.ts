import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { Claim } from '../../../index.js'
import { decodeState, encodeState } from './state_store.js'
import type { RemoteAuthenticationState } from './state_store.js'
import {
  claimsToSession,
  decodeSession,
  decodeTicketRef,
  encodeSession,
  encodeTicketRef,
} from './session_store.js'

/** Cookies are sealed per strategy, so every codec call needs the scheme it belongs to. */
const SCHEME = 'OIDC'
const ISSUER = 'https://example.com'

const secretArb = fc.string({ minLength: 32, maxLength: 64 })

const stateArb: fc.Arbitrary<RemoteAuthenticationState> = fc.record({
  state: fc.string(),
  nonce: fc.string(),
  codeVerifier: fc.string(),
  pkceMethod: fc.constantFrom<'S256' | 'plain'>('S256', 'plain'),
  returnTo: fc.string(),
  scheme: fc.constant(SCHEME),
  issuer: fc.constant(ISSUER),
})

/** Claim values must survive a JSON round-trip inside the JWT payload. */
const claimArb = fc.record({
  type: fc.string({ minLength: 1 }),
  value: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.string(), { maxLength: 3 })),
  issuer: fc.string(),
})

describe('state cookie codec (property)', () => {
  it.prop([stateArb, secretArb])('encode then decode preserves every field', async (state, secret) => {
    const decoded = await decodeState(await encodeState(state, secret, SCHEME), secret, SCHEME)

    expect(decoded.state).toBe(state.state)
    expect(decoded.nonce).toBe(state.nonce)
    expect(decoded.codeVerifier).toBe(state.codeVerifier)
    expect(decoded.pkceMethod).toBe(state.pkceMethod)
    expect(decoded.returnTo).toBe(state.returnTo)
  })

  it.prop([stateArb, secretArb, secretArb])(
    'decoding with any other secret always fails',
    async (state, secret, other) => {
      fc.pre(secret !== other)
      const token = await encodeState(state, secret, SCHEME)
      await expect(decodeState(token, other, SCHEME)).rejects.toThrow()
    },
  )

  /**
   * base64url is not canonical in its trailing bits: a segment whose bit length is not a
   * multiple of six carries padding bits in its final character, so two distinct characters
   * can decode to identical bytes. A 16-byte GCM tag is 128 bits in 22 characters — four
   * padding bits — so flipping `A` to `B` there changes the text and not the ciphertext.
   * The guarantee is over the decoded bytes, not the encoding.
   */
  function decodesIdentically(a: string, b: string): boolean {
    const bytes = (s: string) => s.split('.').map(seg => Buffer.from(seg, 'base64url').toString('hex')).join('.')
    return bytes(a) === bytes(b)
  }

  it.prop([stateArb, secretArb, fc.nat()])(
    'any change to the token bytes is rejected',
    async (state, secret, position) => {
      const token = await encodeState(state, secret, SCHEME)
      const idx = position % token.length
      const original = token[idx]
      // Staying in the base64url alphabet keeps the token structurally parseable, so a
      // rejection has to come from the AEAD tag rather than a decode error.
      const replacement = original === 'A' ? 'B' : 'A'
      const tampered = token.slice(0, idx) + replacement + token.slice(idx + 1)

      fc.pre(!decodesIdentically(tampered, token))
      await expect(decodeState(tampered, secret, SCHEME)).rejects.toThrow()
    },
  )
})

describe('session cookie codec (property)', () => {
  it.prop([fc.array(claimArb, { maxLength: 6 }), fc.string(), secretArb])(
    'encode then decode preserves claims and scheme',
    async (claims, scheme, secret) => {
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), scheme)
      const decoded = await decodeSession(await encodeSession(session, secret, SCHEME, 3600), secret, SCHEME)

      expect(decoded.scheme).toBe(scheme)
      expect(decoded.claims).toEqual(session.claims)
    },
  )

  it.prop([fc.array(claimArb, { maxLength: 4 }), secretArb, secretArb])(
    'decoding with any other secret always fails',
    async (claims, secret, other) => {
      fc.pre(secret !== other)
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), 'OIDC')
      const token = await encodeSession(session, secret, SCHEME, 3600)
      await expect(decodeSession(token, other, SCHEME)).rejects.toThrow()
    },
  )
})

describe('cookie type separation (property)', () => {
  // Each purpose derives its own key from the shared secret, so cross-use fails at
  // decryption; the explicit `typ` header (RFC 8725 §3.11) is the second line. The
  // example-based suite asserts this for a single pair; here it must hold for every state
  // and every claim set.
  it.prop([stateArb, secretArb])('a state token is never accepted as a session', async (state, secret) => {
    const token = await encodeState(state, secret, SCHEME)
    await expect(decodeSession(token, secret, SCHEME)).rejects.toThrow()
  })

  it.prop([fc.array(claimArb, { maxLength: 4 }), secretArb])(
    'a session token is never accepted as state',
    async (claims, secret) => {
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), 'OIDC')
      const token = await encodeSession(session, secret, SCHEME, 3600)
      await expect(decodeState(token, secret, SCHEME)).rejects.toThrow()
    },
  )

  /**
   * The ticket reference joins the same scheme. This pair matters most: an inline session
   * cookie is a complete credential by itself, so accepting one where a reference is expected
   * would route straight around the revocation the ticket store exists to provide.
   */
  const keyArb = fc.string({ minLength: 1 })

  it.prop([keyArb, secretArb])('a ticket reference is never accepted as a session', async (key, secret) => {
    const token = await encodeTicketRef(key, secret, SCHEME, 3600)
    await expect(decodeSession(token, secret, SCHEME)).rejects.toThrow()
  })

  it.prop([keyArb, secretArb])('a ticket reference is never accepted as state', async (key, secret) => {
    const token = await encodeTicketRef(key, secret, SCHEME, 3600)
    await expect(decodeState(token, secret, SCHEME)).rejects.toThrow()
  })

  it.prop([fc.array(claimArb, { maxLength: 4 }), secretArb])(
    'a session token is never accepted as a ticket reference',
    async (claims, secret) => {
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), 'OIDC')
      const token = await encodeSession(session, secret, SCHEME, 3600)
      await expect(decodeTicketRef(token, secret, SCHEME)).rejects.toThrow()
    },
  )

  it.prop([stateArb, secretArb])(
    'a state token is never accepted as a ticket reference',
    async (state, secret) => {
      const token = await encodeState(state, secret, SCHEME)
      await expect(decodeTicketRef(token, secret, SCHEME)).rejects.toThrow()
    },
  )
})

describe('ticket reference codec (property)', () => {
  const keyArb = fc.string({ minLength: 1 })

  it.prop([keyArb, secretArb])('encode then decode returns the key unchanged', async (key, secret) => {
    expect(await decodeTicketRef(await encodeTicketRef(key, secret, SCHEME, 3600), secret, SCHEME)).toBe(key)
  })

  it.prop([keyArb, secretArb, secretArb])(
    'decoding with any other secret always fails',
    async (key, secret, other) => {
      fc.pre(secret !== other)
      await expect(decodeTicketRef(await encodeTicketRef(key, secret, SCHEME, 3600), other, SCHEME)).rejects.toThrow()
    },
  )

  // The reference is opaque by construction, but the cookie must not become a place a key
  // could be read from in cleartext the way the pre-JWE session cookie leaked its claims.
  it.prop([fc.string({ minLength: 8 }), secretArb])(
    'the key never appears in the token',
    async (key, secret) => {
      expect(await encodeTicketRef(key, secret, SCHEME, 3600)).not.toContain(key)
    },
  )
})
