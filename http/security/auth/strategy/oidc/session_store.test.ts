import { describe, it, expect } from 'vitest'
import { Claim } from '../../../index.js'
import { encodeSession, decodeSession, claimsToSession } from './session_store.js'
import type { OidcSession } from './session_store.js'
import { encodeState, decodeState } from './state_store.js'

const SECRET = 'test-session-secret-at-least-32-chars!!'

const SESSION: OidcSession = {
  claims: [
    { type: 'sub', value: 'user123', issuer: 'https://example.com' },
    { type: 'email', value: 'user@example.com', issuer: 'https://example.com' },
  ],
  scheme: 'Google',
}

describe('session_store', () => {
  it('encode then decode preserves claims and scheme', async () => {
    const token = await encodeSession(SESSION, SECRET, 3600)
    const decoded = await decodeSession(token, SECRET)

    expect(decoded.scheme).toBe(SESSION.scheme)
    expect(decoded.claims).toHaveLength(2)
    expect(decoded.claims[0].type).toBe('sub')
    expect(decoded.claims[0].value).toBe('user123')
    expect(decoded.claims[1].type).toBe('email')
  })

  it('decode throws on tampered token', async () => {
    const token = await encodeSession(SESSION, SECRET, 3600)
    const tampered = token.slice(0, -5) + 'XXXXX'
    await expect(decodeSession(tampered, SECRET)).rejects.toThrow()
  })

  it('decode throws when signed with wrong secret', async () => {
    const token = await encodeSession(SESSION, SECRET, 3600)
    await expect(decodeSession(token, 'wrong-secret-at-least-32-chars!!')).rejects.toThrow()
  })

  // The two cookies share a signing secret, so only the explicit `typ` header (RFC 8725
  // §3.11) stops one being replayed as the other.
  it('decode rejects a state token even though it is signed with the same secret', async () => {
    const stateToken = await encodeState(
      { state: 's', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/' },
      SECRET,
    )
    await expect(decodeSession(stateToken, SECRET)).rejects.toThrow(/typ/i)
  })

  it('decode rejects a session token presented as state', async () => {
    const token = await encodeSession(SESSION, SECRET, 3600)
    await expect(decodeState(token, SECRET)).rejects.toThrow(/typ/i)
  })
})

describe('claimsToSession()', () => {
  it('maps Claim[] to OidcSession format', () => {
    const claims = [
      new Claim('sub', 'u1', 'issuer'),
      new Claim('email', 'u@x.com', 'issuer'),
    ]
    const session = claimsToSession(claims, 'TestScheme')

    expect(session.scheme).toBe('TestScheme')
    expect(session.claims).toHaveLength(2)
    expect(session.claims[0]).toEqual({ type: 'sub', value: 'u1', issuer: 'issuer' })
    expect(session.claims[1]).toEqual({ type: 'email', value: 'u@x.com', issuer: 'issuer' })
  })
})
