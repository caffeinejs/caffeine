import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import { Claim } from '../../../index.js'
import { decodeState, encodeState } from './state_store.js'
import type { OidcState } from './state_store.js'
import { claimsToSession, decodeSession, encodeSession } from './session_store.js'

const secretArb = fc.string({ minLength: 32, maxLength: 64 })

const stateArb: fc.Arbitrary<OidcState> = fc.record({
  state: fc.string(),
  nonce: fc.string(),
  codeVerifier: fc.string(),
  pkceMethod: fc.constantFrom<'S256' | 'plain'>('S256', 'plain'),
  returnTo: fc.string(),
})

/** Claim values must survive a JSON round-trip inside the JWT payload. */
const claimArb = fc.record({
  type: fc.string({ minLength: 1 }),
  value: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.string(), { maxLength: 3 })),
  issuer: fc.string(),
})

describe('state cookie codec (property)', () => {
  it.prop([stateArb, secretArb])('encode then decode preserves every field', async (state, secret) => {
    const decoded = await decodeState(await encodeState(state, secret), secret)

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
      const token = await encodeState(state, secret)
      await expect(decodeState(token, other)).rejects.toThrow()
    },
  )

  it.prop([stateArb, secretArb, fc.nat()])(
    'any single-character change to the token is rejected',
    async (state, secret, position) => {
      const token = await encodeState(state, secret)
      const idx = position % token.length
      const original = token[idx]
      // base64url alphabet, so a substitution keeps the token structurally parseable and
      // the failure has to come from the signature rather than a decode error.
      const replacement = original === 'A' ? 'B' : 'A'
      const tampered = token.slice(0, idx) + replacement + token.slice(idx + 1)

      fc.pre(tampered !== token)
      await expect(decodeState(tampered, secret)).rejects.toThrow()
    },
  )
})

describe('session cookie codec (property)', () => {
  it.prop([fc.array(claimArb, { maxLength: 6 }), fc.string(), secretArb])(
    'encode then decode preserves claims and scheme',
    async (claims, scheme, secret) => {
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), scheme)
      const decoded = await decodeSession(await encodeSession(session, secret, 3600), secret)

      expect(decoded.scheme).toBe(scheme)
      expect(decoded.claims).toEqual(session.claims)
    },
  )

  it.prop([fc.array(claimArb, { maxLength: 4 }), secretArb, secretArb])(
    'decoding with any other secret always fails',
    async (claims, secret, other) => {
      fc.pre(secret !== other)
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), 'OIDC')
      const token = await encodeSession(session, secret, 3600)
      await expect(decodeSession(token, other)).rejects.toThrow()
    },
  )
})

describe('cookie type separation (property)', () => {
  // Both cookies are signed with the same secret, so only the explicit `typ` header
  // (RFC 8725 §3.11) stops one standing in for the other. The example-based suite asserts
  // this for a single pair; here it must hold for every state and every claim set.
  it.prop([stateArb, secretArb])('a state token is never accepted as a session', async (state, secret) => {
    const token = await encodeState(state, secret)
    await expect(decodeSession(token, secret)).rejects.toThrow()
  })

  it.prop([fc.array(claimArb, { maxLength: 4 }), secretArb])(
    'a session token is never accepted as state',
    async (claims, secret) => {
      const session = claimsToSession(claims.map(c => new Claim(c.type, c.value, c.issuer)), 'OIDC')
      const token = await encodeSession(session, secret, 3600)
      await expect(decodeState(token, secret)).rejects.toThrow()
    },
  )
})
