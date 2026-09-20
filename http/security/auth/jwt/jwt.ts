import { errors, type JWTPayload } from 'jose'

import type { Context } from '../../../context.js'
import { Claim, Identity, Principal } from '../../index.js'
import { parseAuthorizationHeader } from '../authorization_header.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { challenge } from '../internal/challenge.js'
import { REGISTERED_CLAIMS } from '../registered_claims.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from '../ticket.js'
import type { JWTAuthenticationOptions } from './jwt_options.js'
import { JWTService } from './jwt_service.js'

export class JWTAuthenticationHandler extends BaseAuthenticationHandler<JWTAuthenticationOptions> {
  readonly #name: string
  readonly #jwt: JWTService

  constructor(name: string, options: JWTAuthenticationOptions) {
    super(options)

    this.#name = name
    this.#jwt = buildService(options)
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
   *
   * The description is about the token and nothing else. A failure that is this server's own — a key set that
   * could not be fetched, a claim mapper that threw — is answered `invalid_token` with no description.
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
      return challenge('Bearer')
    }

    // `!== false`, not `=== true`: the builder defaults this on, but a handler constructed directly leaves
    // it undefined, and the two paths must not disagree about what the default is.
    const description = this.options.includeErrorDetails !== false ? describeTokenFault(error) : undefined

    return challenge('Bearer', { error: 'invalid_token', error_description: description })
  }

  /** Answers 403 with RFC 6750 §3.1 `insufficient_scope`: the token was good, and it is not enough. */
  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403).appendHeader('WWW-Authenticate', challenge('Bearer', { error: 'insufficient_scope' }))
  }
}

/** The jose failures that say something about the token the caller sent, as opposed to this server's own trouble. */
const TOKEN_FAULTS: ReadonlySet<string> = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JWKS_NO_MATCHING_KEY',
])

/**
 * The `error_description` for a rejected token, or `undefined` when the failure is not the token's.
 *
 * jose's own messages are fixed text about a claim or a signature. Anything else that was caught along the way —
 * a network error from a key resolver, whatever a claim mapper threw — would hand an unauthenticated caller a look
 * inside the server.
 *
 * RFC 6750 §3 admits no `"` and no `\` in the value, escaped or not, and nothing outside printable ASCII.
 */
function describeTokenFault(error: Error): string | undefined {
  if (!(error instanceof errors.JOSEError) || !TOKEN_FAULTS.has(error.code)) {
    return undefined
  }

  return error.message.replace(/"/g, "'").replace(/[^\x20-\x21\x23-\x5B\x5D-\x7E]/g, '')
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
