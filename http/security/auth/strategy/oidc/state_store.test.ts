import { describe, it, expect } from 'vitest'
import { encodeState, decodeState } from './state_store.js'
import type { OidcState } from './state_store.js'

const SECRET = 'test-state-secret-at-least-32-chars!!'

const STATE: OidcState = {
  state: 'abc123',
  nonce: 'nonce456',
  codeVerifier: 'verifier789',
  pkceMethod: 'S256',
  returnTo: '/dashboard',
}

describe('state_store', () => {
  it('encode then decode preserves all fields', async () => {
    const token = await encodeState(STATE, SECRET)
    const decoded = await decodeState(token, SECRET)

    expect(decoded.state).toBe(STATE.state)
    expect(decoded.nonce).toBe(STATE.nonce)
    expect(decoded.codeVerifier).toBe(STATE.codeVerifier)
    expect(decoded.pkceMethod).toBe(STATE.pkceMethod)
    expect(decoded.returnTo).toBe(STATE.returnTo)
  })

  it('decode throws on tampered token', async () => {
    const token = await encodeState(STATE, SECRET)
    const tampered = token.slice(0, -5) + 'XXXXX'
    await expect(decodeState(tampered, SECRET)).rejects.toThrow()
  })

  it('decode throws when signed with wrong secret', async () => {
    const token = await encodeState(STATE, SECRET)
    await expect(decodeState(token, 'wrong-secret-at-least-32-chars!!')).rejects.toThrow()
  })

  it('preserves plain pkceMethod', async () => {
    const plain: OidcState = { ...STATE, pkceMethod: 'plain' }
    const token = await encodeState(plain, SECRET)
    const decoded = await decodeState(token, SECRET)
    expect(decoded.pkceMethod).toBe('plain')
  })
})
