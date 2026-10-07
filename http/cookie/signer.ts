import { errMessage } from '@caffeinejs/std/framework'

import { ErrCookieConfiguration } from './errors.js'

/** One secret, or several: the first signs, and any of them verifies. */
export type CookieSecret = string | readonly string[]

export type CookieSigningAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512'

/** What verifying a signed value found. `renew` says a secret other than the first verified it. */
export type CookieUnsignResult =
  | { readonly valid: true; readonly renew: boolean; readonly value: string }
  | { readonly valid: false; readonly renew: false; readonly value: null }

/** The fewest characters a cookie secret may have. Below it, a brute-forced secret forges any cookie. */
export const MIN_COOKIE_SECRET_LENGTH = 32

/**
 * Signs cookie values and verifies them back. The class a custom signer extends, and the container key it is bound
 * under: `.cookie(k => k.signer(CookieSigner))`.
 *
 * A `secret` handed to either method replaces the signer's own for that call. The first entry signs and any entry
 * verifies, as the configured secrets do.
 */
export abstract class CookieSigner {
  abstract sign(value: string, secret?: CookieSecret): Promise<string>

  /** Answers `{ valid: false }` for a forged or malformed value; it never rejects over one. */
  abstract unsign(signed: string, secret?: CookieSecret): Promise<CookieUnsignResult>
}

export interface HMACCookieSignerOptions {
  /** Optional: a signer without one signs only with the secret a call hands it. */
  secret?: CookieSecret
  /** Defaults to `SHA-256`. */
  algorithm?: CookieSigningAlgorithm
}

const SIGNATURE_LENGTH: Readonly<Record<CookieSigningAlgorithm, number>> = {
  'SHA-256': 43,
  'SHA-384': 64,
  'SHA-512': 86,
}

const BASE64 = /^[A-Za-z0-9+/]+$/
const INVALID: CookieUnsignResult = { valid: false, renew: false, value: null }

// How many secrets handed to single calls keep their imported key. Past it, the one used least recently is imported
// again on its next use.
const MAX_CALL_KEYS = 64

const encoder = new TextEncoder()

/**
 * What the cookie plugin reads off the built-in signer: whether it has secrets of its own, and how long its signatures
 * are, so a signed cookie is checked where it is set. Kept out of the barrel.
 */
export const kSigning = Symbol('caffeine.http.cookies.signing')

/**
 * Signs with HMAC through Web Crypto, in the format `@fastify/cookie` and `cookie-signature` write: the value, a dot,
 * and the signature in base64 without padding. A cookie either of them signed verifies here, and the reverse.
 *
 * A secret handed to a call is imported on its first use, and the keys of the 64 used most recently are kept.
 *
 * @throws ErrCookieConfiguration when a secret is shorter than {@link MIN_COOKIE_SECRET_LENGTH} characters, the list
 * is empty, or the algorithm is not one of `SHA-256`, `SHA-384` and `SHA-512`.
 */
export class HMACCookieSigner extends CookieSigner {
  readonly #algorithm: CookieSigningAlgorithm
  readonly #secrets: readonly string[] | undefined
  readonly #callKeys = new Map<string, Promise<CryptoKey>>()
  #keys: Promise<CryptoKey[]> | undefined

  constructor(options: HMACCookieSignerOptions = {}) {
    super()

    const algorithm = options.algorithm ?? 'SHA-256'
    if (!Object.hasOwn(SIGNATURE_LENGTH, algorithm)) {
      throw new ErrCookieConfiguration(
        errMessage(`Cannot sign cookies: unsupported algorithm "${String(algorithm)}"`)
          .solutions('Use one of "SHA-256", "SHA-384" and "SHA-512"')
          .reference('@caffeinejs/http', ErrCookieConfiguration)
          .build(),
      )
    }

    this.#algorithm = algorithm
    this.#secrets = options.secret === undefined ? undefined : secretList(options.secret)
  }

  get [kSigning](): { readonly configured: boolean; readonly signatureLength: number } {
    return { configured: this.#secrets !== undefined, signatureLength: SIGNATURE_LENGTH[this.#algorithm] }
  }

  async sign(value: string, secret?: CookieSecret): Promise<string> {
    const [key] = await this.#keysFor(secret)
    const mac = await crypto.subtle.sign('HMAC', key!, encoder.encode(value))

    return `${value}.${toBase64(new Uint8Array(mac))}`
  }

  async unsign(signed: string, secret?: CookieSecret): Promise<CookieUnsignResult> {
    const keys = await this.#keysFor(secret)

    if (typeof signed !== 'string') {
      return INVALID
    }

    const dot = signed.lastIndexOf('.')
    if (dot < 0) {
      return INVALID
    }

    const value = signed.slice(0, dot)
    const signature = signed.slice(dot + 1)

    // Shape first, so a malformed cookie costs no cryptography. Re-encoding catches what `atob` lets through: the
    // unused low bits of the last character, which would give one signature several spellings.
    if (signature.length !== SIGNATURE_LENGTH[this.#algorithm] || !BASE64.test(signature)) {
      return INVALID
    }

    const mac = fromBase64(signature)
    if (toBase64(mac) !== signature) {
      return INVALID
    }

    const data = encoder.encode(value)

    for (let i = 0; i < keys.length; i++) {
      if (await crypto.subtle.verify('HMAC', keys[i]!, mac, data)) {
        return { valid: true, renew: i > 0, value }
      }
    }

    return INVALID
  }

  #keysFor(secret: CookieSecret | undefined): Promise<CryptoKey[]> {
    if (secret !== undefined) {
      return Promise.all(secretList(secret).map(entry => this.#callKey(entry)))
    }

    if (this.#secrets === undefined) {
      return Promise.reject(
        new ErrCookieConfiguration(
          errMessage('Cannot sign cookies: no secret is configured')
            .solutions(
              'Configure one with ".cookie(k => k.secret(...))"',
              'Hand one to the call: "{ secret }", or "ctx.req.signedCookie(name, secret)"',
            )
            .reference('@caffeinejs/http', ErrCookieConfiguration)
            .build(),
        ),
      )
    }

    // Imported by the first sign or verify, and only then: every later one reuses the keys.
    this.#keys ??= Promise.all(this.#secrets.map(entry => importKey(entry, this.#algorithm)))
    return this.#keys
  }

  #callKey(secret: string): Promise<CryptoKey> {
    let key = this.#callKeys.get(secret)

    if (key === undefined) {
      if (this.#callKeys.size >= MAX_CALL_KEYS) {
        this.#callKeys.delete(this.#callKeys.keys().next().value!)
      }

      key = importKey(secret, this.#algorithm)
    } else {
      // A map keeps insertion order and the first entry is the one dropped: one used again goes to the back.
      this.#callKeys.delete(secret)
    }

    this.#callKeys.set(secret, key)
    return key
  }
}

/**
 * Every secret of `secret`, checked against the floor. A failure names a secret by its position, never its value.
 *
 * @throws ErrCookieConfiguration when the list is empty or a secret is too short.
 */
export function secretList(secret: CookieSecret): readonly string[] {
  const list = typeof secret === 'string' ? [secret] : [...secret]

  if (list.length === 0) {
    throw new ErrCookieConfiguration('Cannot sign cookies: the list of secrets is empty')
  }

  for (let i = 0; i < list.length; i++) {
    const entry = list[i]

    if (typeof entry !== 'string' || entry.length < MIN_COOKIE_SECRET_LENGTH) {
      throw new ErrCookieConfiguration(
        (list.length === 1 ? 'Cannot sign cookies: the secret' : `Cannot sign cookies: secret ${i} of the list`) +
          ` must be at least ${MIN_COOKIE_SECRET_LENGTH} characters`,
      )
    }
  }

  return list
}

function importKey(secret: string, algorithm: CookieSigningAlgorithm): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: algorithm }, false, [
    'sign',
    'verify',
  ])
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  // Unpadded: `btoa` pads with at most two "=", and only at the end.
  const encoded = btoa(binary)
  const padding = encoded.indexOf('=')

  return padding < 0 ? encoded : encoded.slice(0, padding)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}
