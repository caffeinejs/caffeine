import { SignJWT, decodeJwt, jwtVerify } from 'jose'
import type { JWTPayload, JWTVerifyGetKey, JWTVerifyOptions, KeyLike } from 'jose'

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

/**
 * Standalone JWT utility over jose: sign, verify and decode.
 */
export class JWTService {
  readonly #signKey?: Uint8Array | KeyLike
  readonly #verifyKey?: Uint8Array | KeyLike
  readonly #resolver?: JWTKeyResolver
  readonly #algorithm: string
  readonly #options: JWTServiceOptions

  constructor(options: JWTServiceOptions) {
    this.#options = options

    if (options.keyResolver != null) {
      this.#resolver = options.keyResolver
      this.#algorithm = options.algorithm ?? 'HS256'
      return
    }

    if (options.secret != null) {
      const key = typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret
      this.#signKey = key
      this.#verifyKey = key
      this.#algorithm = options.algorithm ?? 'HS256'
      return
    }

    if (options.publicKey == null) {
      throw new Error('Cannot create JWTService: provide a "secret" or a "publicKey"/"privateKey" pair')
    }
    if (options.algorithm == null) {
      throw new Error('Cannot create JWTService: an "algorithm" is required for an asymmetric key pair')
    }

    this.#signKey = options.privateKey
    this.#verifyKey = options.publicKey
    this.#algorithm = options.algorithm
  }

  /**
   * Signs a payload into a compact JWT. Claims from `options` override the service defaults.
   *
   * @throws Error when the service has no signing key (verify-only configuration).
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
    if (expiresIn != null) {
      jwt.setExpirationTime(relativeTime(expiresIn))
    }

    const notBefore = options.notBefore ?? this.#options.notBefore
    if (notBefore != null) {
      jwt.setNotBefore(relativeTime(notBefore))
    }

    if (options.jwtid != null) {
      jwt.setJti(options.jwtid)
    }

    const key = this.#resolver ? await this.#resolver({ operation: 'sign', payload }) : this.#signKey
    if (key == null) {
      throw new Error('Cannot sign JWT: no signing key configured (provide a "secret", "privateKey" or "keyResolver")')
    }

    return jwt.sign(key)
  }

  /**
   * Verifies a token's signature and claims, returning its payload. Rejects on any failure
   * (bad signature, expiry, issuer/audience mismatch). `options` merge over the service defaults.
   */
  async verify<T extends JWTPayload = JWTPayload>(token: string, options: JWTVerifyOptions = {}): Promise<T> {
    const verifyOptions: JWTVerifyOptions = {
      algorithms: [this.#algorithm],
      issuer: this.#options.issuer,
      audience: this.#options.audience,
      clockTolerance: this.#options.clockTolerance,
      ...options,
    }

    // Split calls so each matches a jwtVerify overload (a union arg satisfies neither).
    const resolver = this.#resolver
    const { payload } = resolver
      ? await jwtVerify(
          token,
          (protectedHeader => resolver({ operation: 'verify', protectedHeader })) as JWTVerifyGetKey,
          verifyOptions,
        )
      : await jwtVerify(token, this.#verifyKey!, verifyOptions)

    return payload as T
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

  keys(privateKey: KeyLike | Uint8Array, publicKey: KeyLike | Uint8Array): this {
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
