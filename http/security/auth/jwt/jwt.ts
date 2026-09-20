import type { JWTPayload } from 'jose'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { parseAuthorizationHeader } from '../authorization_header.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { REGISTERED_CLAIMS } from '../registered_claims.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from '../ticket.js'
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
    const token = parseAuthorizationHeader(ctx.req.header('authorization'), 'Bearer')
    if (token === undefined) {
      return AuthenticateResult.none()
    }

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

  /**
   * Answers 401 with the RFC 6750 §3 challenge.
   *
   * A bare `Bearer` says only "credentials required", which is indistinguishable from "your token was
   * fine but something else went wrong" — the client cannot tell whether to refresh, re-authenticate, or
   * give up. When this request already tried and failed to validate a token, that reason is named:
   * `error="invalid_token"` plus, if `includeErrorDetails` is on, the underlying description.
   *
   * Nothing is invented: the parameters appear only when this scheme actually failed in this request, which
   * is what `previous` carries. A caller who presented no credential at all gets the bare challenge, since
   * there is no token to fault — and so does a caller who challenges without having authenticated.
   */
  override async challenge(
    ctx: Context,
    _properties?: AuthenticationProperties,
    previous?: AuthenticateResult,
  ): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    ctx.status(401).appendHeader('WWW-Authenticate', this.#challengeHeader(previous?.error))
  }

  #challengeHeader(error: Error | undefined): string {
    if (error === undefined) {
      return 'Bearer'
    }

    const parameters = [`error="invalid_token"`]
    // `!== false`, not `=== true`: the builder defaults this on, but a handler constructed directly leaves
    // it undefined, and the two paths must not disagree about what the default is.
    if (this.options.includeErrorDetails !== false) {
      // Quoted-string per RFC 9110 §5.6.4: a message may carry quotes or backslashes, and an unescaped
      // one would terminate the parameter early and produce a header the client parses as something else.
      parameters.push(`error_description="${error.message.replace(/[\\"]/g, '\\$&')}"`)
    }

    return `Bearer ${parameters.join(', ')}`
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

/**
 * Maps a verified payload to claims, dropping the registered ones.
 *
 * The OIDC handler has always excluded these; this scheme did not, so `iss`/`exp`/`aud` and friends
 * landed on the principal where an application claim type could collide with them.
 */
function mapClaims(payload: JWTPayload): Claim[] {
  const issuer = payload.iss ?? ''
  const claims: Claim[] = []

  for (const [type, value] of Object.entries(payload)) {
    if (REGISTERED_CLAIMS.has(type)) {
      continue
    }
    claims.push(new Claim(type, value, issuer))
  }

  return claims
}
