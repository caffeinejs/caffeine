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

/** A secret a token is sealed with. */
export type SealingSecret = string | Uint8Array

/** One secret, or several: the first seals, and any of them opens. */
export type SealingSecrets = SealingSecret | readonly SealingSecret[]

/** A token {@link openJWT} opened. `renew` says a secret other than the first opened it. */
export interface OpenedJWT<T> {
  claims: T
  /** When it expires, in seconds since the epoch. */
  exp: number
  renew: boolean
}

/** The secrets of `secret`, in order. */
export function sealingSecrets(secret: SealingSecrets): readonly SealingSecret[] {
  return typeof secret === 'string' || secret instanceof Uint8Array ? [secret] : secret
}

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
 * Seals with the first of `secret`'s secrets.
 *
 * @param typ - The token's purpose, written to the `typ` header and demanded back by {@link unsealJWT}.
 * @param info - The key derivation label. Tokens sealed under different labels cannot open one another.
 */
export async function sealJWT(
  payload: Record<string, unknown>,
  typ: string,
  secret: SealingSecrets,
  info: string,
  ttlSeconds: number,
): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: ALG, enc: ENC, typ })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(await sealingKey(firstOf(sealingSecrets(secret)), info))
}

/**
 * Opens a token {@link sealJWT} made, with the same `typ` and `info`, trying `secret`'s secrets in order.
 *
 * Rejects on anything else: a key none of them derives, another purpose, a changed byte, an expired token. The two
 * algorithms are pinned rather than read off the token (RFC 8725 §3.1), so what the token says about itself decides
 * nothing.
 */
export async function openJWT<T>(
  token: string,
  typ: string,
  secret: SealingSecrets,
  info: string,
): Promise<OpenedJWT<T>> {
  const secrets = sealingSecrets(secret)
  firstOf(secrets)

  for (let i = 0; ; i++) {
    try {
      const { payload } = await jwtDecrypt(token, await sealingKey(secrets[i]!, info), {
        typ,
        keyManagementAlgorithms: [ALG],
        contentEncryptionAlgorithms: [ENC],
      })

      return { claims: payload as unknown as T, exp: payload.exp!, renew: i > 0 }
    } catch (err) {
      // Only a key that could not decrypt it is worth trying the next secret for. An expired token, or one of
      // another purpose, was decrypted: the key was right, and another would fail it the same way.
      if (i + 1 >= secrets.length || (err as { code?: unknown }).code !== 'ERR_JWE_DECRYPTION_FAILED') {
        throw err
      }
    }
  }
}

/** The claims of a token {@link openJWT} opens. */
export async function unsealJWT<T>(token: string, typ: string, secret: SealingSecrets, info: string): Promise<T> {
  return (await openJWT<T>(token, typ, secret, info)).claims
}

function firstOf(secrets: readonly SealingSecret[]): SealingSecret {
  if (secrets.length === 0) {
    throw new TypeError('Cannot seal or open a token: the list of secrets is empty')
  }

  return secrets[0]!
}
