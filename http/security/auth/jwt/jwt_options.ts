import { KeyLike } from 'crypto'
import { JWTPayload, JWTVerifyOptions, type KeyLike as JoseKeyLike } from 'jose'
import { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { JWTKeyResolver, JWTServiceOptions } from './jwt_service_options.js'

export interface JWTAuthenticationOptions {
  secret: string | Uint8Array | KeyLike
  jwtOptions?: JWTVerifyOptions
  roleClaimType?: string
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
  readonly #options: JWTAuthenticationOptions = {
    secret: '',
    jwtOptions: {
      algorithms: ['HS256'],
      issuer: undefined,
      audience: undefined,
    },
    roleClaimType: 'roles',
  }

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

  build(): JWTAuthenticationOptions {
    this.#options.serviceOptions = this.#service
    return this.#options
  }
}
