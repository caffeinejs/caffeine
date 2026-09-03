import { jwtDecrypt } from 'jose'
import { describe, it, expect } from 'vitest'

import { Claim } from '../../../index.js'
import { keyFor } from './_sealed_cookie.js'
import type { OIDCTokenPurpose } from './_sealed_cookie.js'
import { claimsToSession, decodeSession, encodeSession } from './session_store.js'
import { decodeState, encodeState } from './state_store.js'

/** Cookies are sealed per strategy, so every codec call needs the scheme it belongs to. */
const SCHEME = 'OIDC'
const ISSUER = 'https://example.com'

const SECRET = 'test-session-secret-at-least-32-chars!!'

const PII_CLAIMS = [
  new Claim('sub', '117000000000000000001', 'https://accounts.google.com'),
  new Claim('email', 'jane.doe@example.com', 'https://accounts.google.com'),
  new Claim('name', 'Jane Doe', 'https://accounts.google.com'),
  new Claim('birthdate', '1985-07-04', 'https://accounts.google.com'),
]

describe('session cookie confidentiality', () => {
  // Regression for the leak this replaced: as a JWS the payload was base64url and every
  // claim was readable by anyone holding the cookie, with no key at all.
  it('exposes no claim value anywhere in the token', async () => {
    const session = claimsToSession(PII_CLAIMS, 'Google')
    const token = await encodeSession(session, SECRET, SCHEME, 3600)

    for (const claim of PII_CLAIMS) {
      expect(token).not.toContain(String(claim.value))
    }

    // Nor after naively base64url-decoding every segment, which is all a JWS required.
    const decodedSegments = token.split('.').map(s => Buffer.from(s, 'base64url').toString('utf8'))
    for (const claim of PII_CLAIMS) {
      expect(decodedSegments.join('')).not.toContain(String(claim.value))
    }
  })

  it('is a five-segment JWE using dir + A256GCM', async () => {
    const token = await encodeSession(claimsToSession(PII_CLAIMS, 'Google'), SECRET, SCHEME, 3600)
    const [header, encryptedKey] = token.split('.')

    expect(token.split('.')).toHaveLength(5)
    // `dir` uses the derived key straight, so there is no wrapped key segment.
    expect(encryptedKey).toBe('')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({
      alg: 'dir',
      enc: 'A256GCM',
      typ: 'oidc-session+jwt',
    })
  })

  it('still round-trips the claims it hides', async () => {
    const session = claimsToSession(PII_CLAIMS, 'Google')
    const decoded = await decodeSession(await encodeSession(session, SECRET, SCHEME, 3600), SECRET, SCHEME)

    expect(decoded.scheme).toBe('Google')
    expect(decoded.claims).toEqual(session.claims)
  })
})

describe('cookie key separation', () => {
  // Uses the real derivation rather than replicating it: a test that reimplements the thing
  // it checks stops testing anything the moment the two drift.
  const key = (purpose: OIDCTokenPurpose, scheme = SCHEME) => keyFor(SECRET, purpose, scheme)

  it('seals the session under a key the state purpose cannot open', async () => {
    const token = await encodeSession(claimsToSession(PII_CLAIMS, 'Google'), SECRET, SCHEME, 3600)

    await expect(jwtDecrypt(token, key('oidc-state+jwt'))).rejects.toThrow()
    await expect(jwtDecrypt(token, key('oidc-session+jwt'))).resolves.toBeDefined()
  })

  it('seals state under a key the session purpose cannot open', async () => {
    const token = await encodeState(
      { state: 's', nonce: 'n', codeVerifier: 'cv', pkceMethod: 'S256', returnTo: '/', scheme: SCHEME, issuer: ISSUER },
      SECRET,
      SCHEME,
    )

    await expect(jwtDecrypt(token, key('oidc-session+jwt'))).rejects.toThrow()
    await expect(jwtDecrypt(token, key('oidc-state+jwt'))).resolves.toBeDefined()
  })

  it('hides the PKCE code_verifier carried by the state cookie', async () => {
    const token = await encodeState(
      {
        state: 's',
        nonce: 'n',
        codeVerifier: 'super-secret-verifier',
        pkceMethod: 'S256',
        returnTo: '/inbox',
        scheme: SCHEME,
        issuer: ISSUER,
      },
      SECRET,
      SCHEME,
    )

    expect(token).not.toContain('super-secret-verifier')
    expect(token).not.toContain('/inbox')
    await expect(decodeState(token, SECRET, SCHEME)).resolves.toMatchObject({
      codeVerifier: 'super-secret-verifier',
    })
  })
})
