import { KeyLike } from 'crypto'
import { JWTPayload, JWTVerifyOptions } from 'jose'
import { Context } from '../../../context.js'
import { Claim } from '../../index.js'

export interface JWTAuthenticationOptions {
  secret: string | Uint8Array | KeyLike
  jwtOptions?: JWTVerifyOptions
  roleClaimType?: string
  claimMapper?: (payload: JWTPayload) => Claim[]
  onTokenValidated?: (ctx: Context, payload: Record<string, unknown>) => Promise<void> | void
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  onChallenge?: (ctx: Context) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
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

  configure(options: Partial<JWTAuthenticationOptions>): this {
    Object.assign(this.#options, options)
    return this
  }

  secret(secret: string | Uint8Array | KeyLike): this {
    this.#options.secret = secret
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
    return this.#options
  }
}
