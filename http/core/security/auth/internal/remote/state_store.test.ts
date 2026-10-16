import { describe, it, expect } from 'vitest'

import { encodeState, decodeState } from './state_store.js'
import type { RemoteAuthenticationState } from './state_store.js'

/** Cookies are sealed per strategy, so every codec call needs the scheme it belongs to. */
const SCHEME = 'OIDC'
const ISSUER = 'https://example.com'

const SECRET = 'test-state-secret-at-least-32-chars!!'

const STATE: RemoteAuthenticationState = {
  state: 'abc123',
  nonce: 'nonce456',
  codeVerifier: 'verifier789',
  pkceMethod: 'S256',
  returnTo: '/dashboard',
  scheme: SCHEME,
  issuer: ISSUER,
}

describe('state_store', () => {
  it('encode then decode preserves all fields', async () => {
    const token = await encodeState(STATE, SECRET, SCHEME)
    const decoded = await decodeState(token, SECRET, SCHEME)

    expect(decoded.state).toBe(STATE.state)
    expect(decoded.nonce).toBe(STATE.nonce)
    expect(decoded.codeVerifier).toBe(STATE.codeVerifier)
    expect(decoded.pkceMethod).toBe(STATE.pkceMethod)
    expect(decoded.returnTo).toBe(STATE.returnTo)
  })

  it('decode throws on tampered token', async () => {
    const token = await encodeState(STATE, SECRET, SCHEME)
    const tampered = token.slice(0, -5) + 'XXXXX'
    await expect(decodeState(tampered, SECRET, SCHEME)).rejects.toThrow()
  })

  it('decode throws when signed with wrong secret', async () => {
    const token = await encodeState(STATE, SECRET, SCHEME)
    await expect(decodeState(token, 'wrong-secret-at-least-32-chars!!', SCHEME)).rejects.toThrow()
  })

  // A sign-in under way when the secrets rotate comes back within its ten minutes; any listed secret opens it, and
  // the first one seals the next.
  it('decodes a state an older secret of the list sealed, and seals with the first', async () => {
    const newer = 'a-newer-state-secret-at-least-32-chars'

    expect(await decodeState(await encodeState(STATE, SECRET, SCHEME), [newer, SECRET], SCHEME)).toMatchObject(STATE)
    expect(await decodeState(await encodeState(STATE, [newer, SECRET], SCHEME), newer, SCHEME)).toMatchObject(STATE)
  })

  it('preserves plain pkceMethod', async () => {
    const plain: RemoteAuthenticationState = { ...STATE, pkceMethod: 'plain' }
    const token = await encodeState(plain, SECRET, SCHEME)
    const decoded = await decodeState(token, SECRET, SCHEME)
    expect(decoded.pkceMethod).toBe('plain')
  })
})
