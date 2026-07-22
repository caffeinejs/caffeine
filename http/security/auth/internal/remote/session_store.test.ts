import { describe, it, expect } from 'vitest'
import { Claim } from '../../../index.js'
import { encodeSession, decodeSession, claimsToSession } from './session_store.js'
import type { RemoteAuthenticationSession } from './session_store.js'
import { encodeState, decodeState } from './state_store.js'

/** Cookies are sealed per strategy, so every codec call needs the scheme it belongs to. */
const SCHEME = 'OIDC'
const ISSUER = 'https://example.com'

const SECRET = 'test-session-secret-at-least-32-chars!!'

const SESSION: RemoteAuthenticationSession = {
  claims: [
    { type: 'sub', value: 'user123', issuer: 'https://example.com' },
    { type: 'email', value: 'user@example.com', issuer: 'https://example.com' },
  ],
  scheme: 'Google',
}

describe('session_store', () => {
  it('encode then decode preserves claims and scheme', async () => {
    const token = await encodeSession(SESSION, SECRET, SCHEME, 3600)
    const decoded = await decodeSession(token, SECRET, SCHEME)

    expect(decoded.scheme).toBe(SESSION.scheme)
    expect(decoded.claims).toHaveLength(2)
    expect(decoded.claims[0].type).toBe('sub')
    expect(decoded.claims[0].value).toBe('user123')
    expect(decoded.claims[1].type).toBe('email')
  })

  it('decode throws on tampered token', async () => {
    const token = await encodeSession(SESSION, SECRET, SCHEME, 3600)
    const tampered = token.slice(0, -5) + 'XXXXX'
    await expect(decodeSession(tampered, SECRET, SCHEME)).rejects.toThrow()
  })

  it('decode throws when signed with wrong secret', async () => {
    const token = await encodeSession(SESSION, SECRET, SCHEME, 3600)
    await expect(decodeSession(token, 'wrong-secret-at-least-32-chars!!', SCHEME)).rejects.toThrow()
  })

  // The two cookies derive independent keys from the same secret, so cross-use fails at
  // decryption before the explicit `typ` header (RFC 8725 §3.11) is even reached.
  it('decode rejects a state token sealed from the same secret', async () => {
    const stateToken = await encodeState(
      { state: 's', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/', scheme: SCHEME, issuer: ISSUER },
      SECRET,
      SCHEME,
    )
    await expect(decodeSession(stateToken, SECRET, SCHEME)).rejects.toThrow()
  })

  it('decode rejects a session token presented as state', async () => {
    const token = await encodeSession(SESSION, SECRET, SCHEME, 3600)
    await expect(decodeState(token, SECRET, SCHEME)).rejects.toThrow()
  })
})

describe('claimsToSession()', () => {
  it('maps Claim[] to RemoteAuthenticationSession format', () => {
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
