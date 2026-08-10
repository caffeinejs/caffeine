import type { JWTPayload } from 'jose'
import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'
import { BaseAuthenticationHandler } from '../handler.js'
import type { JWTAuthenticationOptions } from './jwt_options.js'
import { JWTService } from './jwt_service.js'

export class JWTAuthenticationHandler extends BaseAuthenticationHandler<JWTAuthenticationOptions> {
  readonly #name: string
  readonly #jwt: JWTService

  constructor(name: string, options: JWTAuthenticationOptions, jwt?: JWTService) {
    super(options)

    this.#name = name
    // The builder injects a shared, DI-bound service (verify + sign); fall back to building one from
    // the options for direct construction.
    this.#jwt = jwt ?? buildService(options)
  }

  /** The JWTService this scheme verifies (and signs) with. Shared via DI, see `jwtServiceKey`. */
  get service(): JWTService {
    return this.#jwt
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const authHeader = ctx.req.header('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return AuthenticateResult.none()
    }

    const token = authHeader.slice(7).trim()

    try {
      const payload = await this.#jwt.verify(token, this.options.jwtOptions)

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

function buildService(options: JWTAuthenticationOptions): JWTService {
  if (options.serviceOptions) {
    return new JWTService(options.serviceOptions)
  }

  // A string/Uint8Array secret is symmetric; a KeyLike is an asymmetric public (verify) key.
  const secret = options.secret
  const algorithm = options.jwtOptions?.algorithms?.[0]
  return typeof secret === 'string' || secret instanceof Uint8Array
    ? new JWTService({ secret, algorithm })
    : new JWTService({ publicKey: secret, algorithm })
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
    claims[i] = new Claim(type, value, issuer)
  }

  return claims
}
