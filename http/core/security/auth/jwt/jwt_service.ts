import { SignJWT, decodeJwt, jwtVerify } from 'jose'
import type { JWTPayload, JWTVerifyGetKey, JWTVerifyOptions, CryptoKey } from 'jose'

import type { JWTKeyResolver, JWTServiceOptions } from './jwt_service_options.js'

// Per-call overrides for sign(). Any field left unset falls back to the service defaults.
export interface JWTSignOptions {
  issuer?: string
  audience?: string | string[]
  subject?: string
  // A number is seconds FROM NOW; a string is a duration ('15m', '1h', '7d').
  expiresIn?: string | number
  notBefore?: string | number
  jwtid?: string
  header?: Record<string, unknown>
}

/** RFC 7518 §3.2: an HMAC key has to be at least as long as the hash it feeds. */
const HMAC = new Map([
  ['HS256', { hash: 'SHA-256', bytes: 32 }],
  ['HS384', { hash: 'SHA-384', bytes: 48 }],
  ['HS512', { hash: 'SHA-512', bytes: 64 }],
])

/**
 * Standalone JWT utility over jose: sign, verify and decode.
 */
export class JWTService {
  readonly #signKey?: Uint8Array | CryptoKey
  readonly #verifyKey?: Uint8Array | CryptoKey
  readonly #resolver?: JWTKeyResolver
  readonly #algorithm: string
  readonly #options: JWTServiceOptions

  // The symmetric secret, imported once. Handed raw bytes, jose imports them again on every sign and verify.
  #hmacKey?: Promise<CryptoKey>

  /**
   * @throws Error when no key is configured, when a symmetric secret is shorter than the hash of its algorithm
   * (RFC 7518 §3.2), or when a key resolver or an asymmetric key pair is given without an `algorithm`.
   */
  constructor(options: JWTServiceOptions) {
    this.#options = options

    if (options.keyResolver != null) {
      // Never defaulted. The algorithm is what stops a token from choosing how it is verified, and a resolver
      // that hands back a public key as bytes would verify any HS256 token signed with that public key.
      if (options.algorithm == null) {
        throw new Error('Cannot create JWTService: an "algorithm" is required with a "keyResolver"')
      }

      this.#resolver = options.keyResolver
      this.#algorithm = options.algorithm
      return
    }

    if (options.secret != null) {
      const key = typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret
      this.#algorithm = options.algorithm ?? 'HS256'

      assertHMACKeyLength(this.#algorithm, 'secret', key)

      this.#signKey = key
      this.#verifyKey = key
      return
    }

    if (options.publicKey == null) {
      throw new Error('Cannot create JWTService: provide a "secret" or a "publicKey"/"privateKey" pair')
    }
    if (options.algorithm == null) {
      throw new Error('Cannot create JWTService: an "algorithm" is required for an asymmetric key pair')
    }

    // A symmetric key may come through here as well, already imported or as bytes: the bearer scheme hands a
    // `CryptoKey` secret over as the public key.
    assertHMACKeyLength(options.algorithm, 'privateKey', options.privateKey)
    assertHMACKeyLength(options.algorithm, 'publicKey', options.publicKey)

    this.#signKey = options.privateKey
    this.#verifyKey = options.publicKey
    this.#algorithm = options.algorithm
  }

  /**
   * Signs a payload into a compact JWT. Claims from `options` override the service defaults.
   *
   * @throws Error when the service has no signing key (verify-only configuration), or when neither `options` nor
   * the service defaults give the token a lifetime: a token that never expires is one that can never be revoked.
   */
  async sign(payload: JWTPayload, options: JWTSignOptions = {}): Promise<string> {
    const jwt = new SignJWT(payload).setProtectedHeader({ ...options.header, alg: this.#algorithm }).setIssuedAt()

    const issuer = options.issuer ?? this.#options.issuer
    if (issuer != null) {
      jwt.setIssuer(issuer)
    }

    const audience = options.audience ?? this.#options.audience
    if (audience != null) {
      jwt.setAudience(audience)
    }

    const subject = options.subject ?? this.#options.subject
    if (subject != null) {
      jwt.setSubject(subject)
    }

    const expiresIn = options.expiresIn ?? this.#options.expiresIn
    if (expiresIn == null) {
      throw new Error('Cannot sign JWT: no "expiresIn" given, and the service has no default lifetime')
    }
    jwt.setExpirationTime(relativeTime(expiresIn))

    const notBefore = options.notBefore ?? this.#options.notBefore
    if (notBefore != null) {
      jwt.setNotBefore(relativeTime(notBefore))
    }

    if (options.jwtid != null) {
      jwt.setJti(options.jwtid)
    }

    const key = this.#resolver ? await this.#resolver({ operation: 'sign', payload }) : await this.#key(this.#signKey)
    if (key == null) {
      throw new Error('Cannot sign JWT: no signing key configured (provide a "secret", "privateKey" or "keyResolver")')
    }

    return jwt.sign(key)
  }

  /**
   * Verifies a token's signature and claims, returning its payload. Rejects on any failure
   * (bad signature, expiry, issuer/audience mismatch). `options` merge over the service defaults.
   *
   * A token with no `exp` is rejected: jose checks an expiry only when there is one, so without this a token minted
   * without a lifetime is good forever. `requiredClaims` adds to that and does not replace it: asking for `sub`
   * asks for `sub` and `exp`. Pass `requiredClaims: []`, and nothing else, to accept a token with no expiry.
   */
  async verify<T extends JWTPayload = JWTPayload>(token: string, options: JWTVerifyOptions = {}): Promise<T> {
    const verifyOptions: JWTVerifyOptions = {
      algorithms: [this.#algorithm],
      issuer: this.#options.issuer,
      audience: this.#options.audience,
      clockTolerance: this.#options.clockTolerance,
      ...options,
      requiredClaims: withExpiry(options.requiredClaims),
    }

    // Split calls so each matches a jwtVerify overload (a union arg satisfies neither).
    const resolver = this.#resolver
    const { payload } = resolver
      ? await jwtVerify(
          token,
          (protectedHeader => resolver({ operation: 'verify', protectedHeader })) as JWTVerifyGetKey,
          verifyOptions,
        )
      : await jwtVerify(token, (await this.#key(this.#verifyKey))!, verifyOptions)

    return payload as T
  }

  /** The key as jose is handed it: a symmetric secret imported once, anything else as it was configured. */
  #key(key: Uint8Array | CryptoKey | undefined): Promise<Uint8Array | CryptoKey | undefined> {
    const hmac = HMAC.get(this.#algorithm)

    if (hmac === undefined || !(key instanceof Uint8Array)) {
      return Promise.resolve(key)
    }

    // Copied: the import wants a view over an `ArrayBuffer` of its own, and the caller keeps theirs.
    return (this.#hmacKey ??= crypto.subtle.importKey(
      'raw',
      Uint8Array.from(key),
      { name: 'HMAC', hash: hmac.hash },
      false,
      ['sign', 'verify'],
    ))
  }

  /**
   * Decodes a token's payload WITHOUT verifying its signature or claims. Never trust the result for
   * authorization decisions — use {@link verify} for that.
   */
  decode<T extends JWTPayload = JWTPayload>(token: string): T {
    return decodeJwt(token) as T
  }
}

export class JWTServiceBuilder {
  readonly #options: JWTServiceOptions = {}

  configure(options: Partial<JWTServiceOptions>): this {
    Object.assign(this.#options, options)
    return this
  }

  secret(secret: string | Uint8Array): this {
    this.#options.secret = secret
    return this
  }

  keys(privateKey: CryptoKey | Uint8Array, publicKey: CryptoKey | Uint8Array): this {
    this.#options.privateKey = privateKey
    this.#options.publicKey = publicKey
    return this
  }

  keyResolver(keyResolver: JWTKeyResolver): this {
    this.#options.keyResolver = keyResolver
    return this
  }

  algorithm(algorithm: string): this {
    this.#options.algorithm = algorithm
    return this
  }

  issuer(issuer: string): this {
    this.#options.issuer = issuer
    return this
  }

  audience(audience: string | string[]): this {
    this.#options.audience = audience
    return this
  }

  subject(subject: string): this {
    this.#options.subject = subject
    return this
  }

  expiresIn(expiresIn: string | number): this {
    this.#options.expiresIn = expiresIn
    return this
  }

  notBefore(notBefore: string | number): this {
    this.#options.notBefore = notBefore
    return this
  }

  clockTolerance(clockTolerance: string | number): this {
    this.#options.clockTolerance = clockTolerance
    return this
  }

  build(): JWTService {
    return new JWTService(this.#options)
  }
}

// jose's setExpirationTime/setNotBefore read a number as an absolute epoch; reinterpret it as
// seconds from now (a string duration like '15m' passes through unchanged).
function relativeTime(value: string | number): string | Date {
  return typeof value === 'number' ? new Date(Date.now() + value * 1000) : value
}

/**
 * Refuses a key shorter than the hash of the HMAC algorithm it is for. Any other algorithm, and a key whose length
 * cannot be read, pass.
 */
function assertHMACKeyLength(algorithm: string, option: string, key: Uint8Array | CryptoKey | undefined): void {
  const hmac = HMAC.get(algorithm)
  if (hmac === undefined || key === undefined) {
    return
  }

  // An imported HMAC key states its length in bits.
  const bits = key instanceof Uint8Array ? key.byteLength * 8 : (key.algorithm as { length?: number }).length
  if (bits !== undefined && bits < hmac.bytes * 8) {
    throw new Error(
      `Cannot create JWTService: a "${option}" for ${algorithm} must be at least ${hmac.bytes} bytes, got ${bits / 8}`,
    )
  }
}

// `exp` on top of whatever the caller requires. An empty list is the caller saying that no claim is required, the
// expiry included, and is the only way to say it.
function withExpiry(requested: string[] | undefined): string[] {
  if (requested === undefined) {
    return ['exp']
  }

  return requested.length === 0 ? [] : [...new Set(['exp', ...requested])]
}
