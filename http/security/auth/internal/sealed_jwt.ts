import { hkdfSync } from 'node:crypto'

import { EncryptJWT, jwtDecrypt } from 'jose'

/**
 * Sealed tokens: a JWT encrypted with a key derived from a secret, for what travels in a cookie.
 *
 * Encrypted, not merely signed (`dir` + `A256GCM`, an AEAD): a signed token leaves its payload base64url-readable
 * by anyone holding the cookie, which for a session means the user's claims in cleartext in the browser jar and
 * in anything that captures request headers. The encryption gives confidentiality *and* integrity, and replaces
 * the signature outright.
 *
 * The key is derived per `info`, so two purposes or two schemes sharing one secret — the common case, since it
 * usually comes from one environment variable — cannot open each other's tokens. Every token also carries its
 * purpose as an explicit `typ` (RFC 8725 §3.11), checked on the way back.
 */

const ALG = 'dir'
const ENC = 'A256GCM'

// The key for one (secret, info) is derived and imported once for the life of the process. A token is opened on
// every request that carries one, and handed raw bytes jose imports them again each time. Two levels, keyed by the
// secret and then by `info`, so that a lookup builds no string of its own.
const stringSecrets = new Map<string, Map<string, Promise<CryptoKey>>>()
const byteSecrets = new WeakMap<Uint8Array, Map<string, Promise<CryptoKey>>>()

/** The content-encryption key for `secret` under the derivation label `info`. */
export function sealingKey(secret: string | Uint8Array, info: string): Promise<CryptoKey> {
  const keys = typeof secret === 'string' ? forString(secret) : forBytes(secret)

  let key = keys.get(info)
  if (key === undefined) {
    const derived = new Uint8Array(hkdfSync('sha256', secret, '', info, 32))
    key = crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    keys.set(info, key)
  }

  return key
}

function forString(secret: string): Map<string, Promise<CryptoKey>> {
  let keys = stringSecrets.get(secret)
  if (keys === undefined) {
    stringSecrets.set(secret, (keys = new Map()))
  }

  return keys
}

function forBytes(secret: Uint8Array): Map<string, Promise<CryptoKey>> {
  let keys = byteSecrets.get(secret)
  if (keys === undefined) {
    byteSecrets.set(secret, (keys = new Map()))
  }

  return keys
}

/**
 * @param typ - The token's purpose, written to the `typ` header and demanded back by {@link unsealJWT}.
 * @param info - The key derivation label. Tokens sealed under different labels cannot open one another.
 */
export async function sealJWT(
  payload: Record<string, unknown>,
  typ: string,
  secret: string | Uint8Array,
  info: string,
  ttlSeconds: number,
): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: ALG, enc: ENC, typ })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(await sealingKey(secret, info))
}

/**
 * Opens a token {@link sealJWT} made, with the same `typ`, `secret` and `info`.
 *
 * Rejects on anything else: another key, another purpose, a changed byte, an expired token. The two algorithms are
 * pinned rather than read off the token (RFC 8725 §3.1), so what the token says about itself decides nothing.
 */
export async function unsealJWT<T>(token: string, typ: string, secret: string | Uint8Array, info: string): Promise<T> {
  const { payload } = await jwtDecrypt(token, await sealingKey(secret, info), {
    typ,
    keyManagementAlgorithms: [ALG],
    contentEncryptionAlgorithms: [ENC],
  })

  return payload as unknown as T
}
