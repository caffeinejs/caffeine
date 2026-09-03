import { KeyLike } from 'crypto'

import { JWTPayload, JWTVerifyOptions, type KeyLike as JoseKeyLike } from 'jose'

import { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { JWTKeyResolver, JWTServiceOptions } from './jwt_service_options.js'

export interface JWTAuthenticationOptions {
  secret: string | Uint8Array | KeyLike
  jwtOptions?: JWTVerifyOptions
  roleClaimType?: string
  /**
   * Includes the validation failure's description in the `WWW-Authenticate` challenge.
   *
   * RFC 6750 §3 `error_description`. On by default: the text
   * describes the *token* the caller presented ("exp claim timestamp check failed"), which they are
   * already in a position to know, and without it a client cannot tell a expired token from a malformed
   * one. Turn it off where even that is more than an unauthenticated caller should learn.
   */
  includeErrorDetails?: boolean
  claimMapper?: (payload: JWTPayload) => Claim[]
  onTokenValidated?: (ctx: Context, payload: Record<string, unknown>) => Promise<void> | void
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  onChallenge?: (ctx: Context) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
  // The full sign+verify service configuration. When present the scheme's JWTService is built from
  // this and shared (verify + sign) — and DI-bound so a controller can inject the same signer.
  serviceOptions?: JWTServiceOptions
}

export class JWTAuthenticationOptionsBuilder {
  // `issuer` and `audience` are absent rather than explicitly `undefined`: `JWTService.verify` spreads
  // these over the service defaults, and a key present with an `undefined` value *erases* the default
  // instead of deferring to it.
  readonly #options: JWTAuthenticationOptions = {
    secret: '',
    jwtOptions: {
      algorithms: ['HS256'],
    },
    roleClaimType: 'roles',
    includeErrorDetails: true,
  }

  #anyIssuer = false
  #anyAudience = false

  // Source of truth for the shared JWTService: keys, algorithm and the issue-time claims. `secret` /
  // `keyPair` also mirror onto the verify path (`#options.secret` / `jwtOptions`).
  readonly #service: JWTServiceOptions = {}

  configure(options: Partial<JWTAuthenticationOptions>): this {
    Object.assign(this.#options, options)
    return this
  }

  secret(secret: string | Uint8Array | KeyLike): this {
    this.#options.secret = secret
    if (typeof secret === 'string' || secret instanceof Uint8Array) {
      this.#service.secret = secret
    } else {
      // A KeyLike here is an asymmetric public (verify) key; signing needs `keyPair`.
      this.#service.publicKey = secret
    }

    return this
  }

  keyPair(privateKey: JoseKeyLike | Uint8Array, publicKey: JoseKeyLike | Uint8Array): this {
    // Keys live on the service options (used for both sign and verify). `#options.secret` is only the
    // fallback path when no service options exist, which `build()` always populates.
    this.#service.privateKey = privateKey
    this.#service.publicKey = publicKey

    return this
  }

  keyResolver(resolver: JWTKeyResolver): this {
    this.#service.keyResolver = resolver
    return this
  }

  algorithm(algorithm: string): this {
    this.#service.algorithm = algorithm
    this.#options.jwtOptions = { ...this.#options.jwtOptions, algorithms: [algorithm] }

    return this
  }

  issuer(issuer: string): this {
    this.#service.issuer = issuer
    this.#options.jwtOptions = { ...this.#options.jwtOptions, issuer }

    return this
  }

  audience(audience: string | string[]): this {
    this.#service.audience = audience
    this.#options.jwtOptions = { ...this.#options.jwtOptions, audience }

    return this
  }

  expiresIn(expiresIn: string | number): this {
    this.#service.expiresIn = expiresIn
    return this
  }

  jwtOptions(jwt: JWTVerifyOptions): this {
    this.#options.jwtOptions = jwt
    return this
  }

  roleClaimType(roleClaimType: string): this {
    this.#options.roleClaimType = roleClaimType
    return this
  }

  /** Whether the 401 challenge names why the token was rejected (RFC 6750 `error_description`). Default on. */
  includeErrorDetails(include: boolean): this {
    this.#options.includeErrorDetails = include
    return this
  }

  claimMapper(claimMapper: (payload: JWTPayload) => Claim[]): this {
    this.#options.claimMapper = claimMapper
    return this
  }

  onTokenValidated(onTokenValidated: (ctx: Context, payload: Record<string, unknown>) => Promise<void> | void): this {
    this.#options.onTokenValidated = onTokenValidated
    return this
  }

  onFail(onFail: (ctx: Context, error: Error) => Promise<void> | void): this {
    this.#options.onFail = onFail
    return this
  }

  onChallenge(onChallenge: (ctx: Context) => Promise<void> | void): this {
    this.#options.onChallenge = onChallenge
    return this
  }

  onForbid(onForbid: (ctx: Context) => Promise<void> | void): this {
    this.#options.onForbid = onForbid
    return this
  }

  /**
   * Accepts a token from any issuer.
   *
   * The waiver exists so that turning the check off is a decision on the record rather than the
   * consequence of not having configured one. Reach for it only where the signing key is genuinely
   * single-purpose and single-tenant.
   */
  allowAnyIssuer(): this {
    this.#anyIssuer = true
    return this
  }

  /** Accepts a token minted for any audience. See {@link allowAnyIssuer} for when that is defensible. */
  allowAnyAudience(): this {
    this.#anyAudience = true
    return this
  }

  build(): JWTAuthenticationOptions {
    // `jose` skips a check whose expected value is undefined, so leaving these unset means the scheme
    // verifies the signature and nothing about who the token was minted by or for. With a symmetric
    // secret — the default — that admits every token signed by anything else holding the same key: a
    // sibling service, a different tenant, a token issued for an unrelated audience.
    //
    // This is refused at build time instead of first request, so opting out has to be written down.
    const jwt = this.#options.jwtOptions
    if (!this.#anyIssuer && jwt?.issuer === undefined) {
      throw new Error(
        'Cannot build JWTAuthenticationOptions: an "issuer" is required — call issuer(...) to pin the ' +
          'token issuer, or allowAnyIssuer() to accept tokens from any issuer',
      )
    }
    if (!this.#anyAudience && jwt?.audience === undefined) {
      throw new Error(
        'Cannot build JWTAuthenticationOptions: an "audience" is required — call audience(...) to pin the ' +
          'token audience, or allowAnyAudience() to accept tokens minted for any audience',
      )
    }

    this.#options.serviceOptions = this.#service
    return this.#options
  }
}
