import { hkdfSync } from 'node:crypto'

import { EncryptJWT, jwtDecrypt } from 'jose'

/**
 * Sealed session cookie for the cookie authentication scheme.
 *
 * Mirrors the OIDC sealed-cookie design (`internal/remote/_sealed_cookie.ts`) but is self-contained:
 * that file is private to its directory and OIDC-`typ`-typed, and cross-directory imports of a
 * `_`-prefixed module are barred by the `no-restricted-imports` rule.
 *
 * The cookie is encrypted (`dir` + `A256GCM`, AEAD), not merely signed, so the user's claims are never
 * base64url-readable in the browser jar. The key is derived per scheme name from the session secret, so
 * two cookie schemes sharing one secret cannot open each other's cookies. Explicit `typ` per RFC 8725.
 */
const ALG = 'dir'
const ENC = 'A256GCM'
const PURPOSE = 'session+jwt'

const keyCache = new Map<string, Uint8Array>()

function keyFor(secret: string | Uint8Array, scheme: string): Uint8Array {
  const info = `caffeine:cookie:${PURPOSE}:${scheme}`
  const secretStr = typeof secret === 'string' ? secret : Buffer.from(secret).toString('base64')
  const cacheKey = `${secretStr} ${info}`
  let derived = keyCache.get(cacheKey)
  if (derived === undefined) {
    derived = new Uint8Array(hkdfSync('sha256', secret, '', info, 32))
    keyCache.set(cacheKey, derived)
  }
  return derived
}

export async function sealSession(
  payload: Record<string, unknown>,
  secret: string | Uint8Array,
  scheme: string,
  ttlSeconds: number,
): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: ALG, enc: ENC, typ: PURPOSE })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(keyFor(secret, scheme))
}

export async function unsealSession<T>(cookie: string, secret: string | Uint8Array, scheme: string): Promise<T> {
  const { payload } = await jwtDecrypt(cookie, keyFor(secret, scheme), { typ: PURPOSE })
  return payload as unknown as T
}
