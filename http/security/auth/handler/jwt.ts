import { jwtVerify } from 'jose'
import type { JWTPayload, KeyLike } from 'jose'
import type { Context } from '../../../context.js'
import { Claim } from '../../claim.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { Identity } from '../../identity.js'
import { Principal } from '../../principal.js'
import type { JWTAuthenticationOptions } from './jwt_options.js'

export class JWTAuthenticationHandler extends BaseAuthenticationHandler<JWTAuthenticationOptions> {
  readonly #name: string
  readonly #secretKey: Uint8Array | KeyLike

  constructor(name: string, options: JWTAuthenticationOptions) {
    super(options)

    this.#name = name
    this.#secretKey = typeof options.secret === 'string'
      ? new TextEncoder().encode(options.secret)
      : options.secret
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const authHeader = ctx.req.header('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return AuthenticateResult.none()
    }

    const token = authHeader.slice(7).trim()

    try {
      const { payload } = await jwtVerify(token, this.#secretKey, this.options.jwtOptions)

      const claims = this.options.claimMapper ? this.options.claimMapper(payload) : mapClaims(payload)
      const identity = new Identity(this.#name, true, claims, this.options.roleClaimType)
      const principal = new Principal(true, identity)

      await this.options.onTokenValidated?.(ctx, payload)

      return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
    } catch (e) {
      await this.options.onFail?.(ctx, e as Error)
      return AuthenticateResult.fail(e as Error)
    }
  }

  override async challenge(ctx: Context): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    ctx.status(401).header('WWW-Authenticate', 'Bearer')
  }

  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)
  }
}

function mapClaims(payload: JWTPayload): Claim[] {
  const entries = Object.entries(payload)
  if (entries.length === 0) {
    return []
  }

  const claims: Claim[] = new Array(entries.length)
  const issuer = payload.iss ?? ''

  for (let i = 0; i < entries.length; i++) {
    const [type, value] = entries[i]
    if (value === undefined || value === null) {
      continue
    }

    claims[i] = new Claim(type, value, issuer)
  }

  return claims
}
