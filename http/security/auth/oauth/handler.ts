import type { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { basicAuthHeader } from '../internal/remote/client_auth.js'
import { ErrOAuthCallback } from '../internal/remote/errors.js'
import { RemoteAuthenticationHandler } from '../internal/remote/handler.js'
import type { RemoteAuthenticationIdentity, RemoteAuthenticationTokens } from '../internal/remote/handler.js'
import { redactPii } from '../internal/remote/pii.js'
import type { RemoteAuthenticationState } from '../internal/remote/state_store.js'
import { fetchUserInfo } from '../internal/remote/userinfo.js'
import type { OAuth2AuthenticationOptions, ResolvedOAuth2AuthenticationOptions } from './options.js'
import { resolveOAuth2Options } from './options.js'

/**
 * A plain OAuth 2.0 strategy for providers that do not implement OpenID Connect.
 *
 * Identity comes from an authenticated call to the provider's user information endpoint rather
 * than a signed id_token, so there is nothing to verify cryptographically: trust rests on TLS,
 * the client secret, PKCE and the state binding. Use the OIDC strategy wherever a provider
 * offers it.
 */
export class OAuth2AuthenticationHandler extends RemoteAuthenticationHandler<ResolvedOAuth2AuthenticationOptions> {
  constructor(name: string, options: OAuth2AuthenticationOptions) {
    // Resolving here rather than trusting the caller means there is exactly one path to a
    // configured handler: constructing one directly still validates and still defaults.
    super(name, resolveOAuth2Options(options, name))
  }

  protected override callbackError(message: string): Error {
    return new ErrOAuthCallback(message)
  }

  /**
   * There is no issuer in plain OAuth 2.0, so the authorization endpoint's origin stands in.
   *
   * It serves the same purpose the OIDC issuer does here: binding the state cookie to the
   * provider it was minted against, so a callback cannot be replayed after reconfiguration.
   */
  protected override resolveIssuer(): Promise<string> {
    return Promise.resolve(new URL(this.options.authorizationEndpoint).origin)
  }

  protected override resolveAuthorizationEndpoint(): Promise<string> {
    return Promise.resolve(this.options.authorizationEndpoint)
  }

  protected override resolvePKCEMethod(): Promise<'S256' | 'plain' | 'none'> {
    // S256 or nothing. `plain` offers no protection against code interception, and a provider
    // that cannot do S256 is better served by turning PKCE off knowingly.
    return Promise.resolve(this.options.usePKCE ? 'S256' : 'none')
  }

  protected override authorizationParams(): Record<string, string> {
    return {}
  }

  protected override async exchangeAndBuildIdentity(
    ctx: Context,
    code: string,
    stored: RemoteAuthenticationState,
  ): Promise<RemoteAuthenticationIdentity> {
    const tokens = await this.#exchangeCode(code, stored)

    if (!tokens.accessToken) {
      throw this.callbackFailure('token response contained no access token')
    }

    let userInfo = await this.#fetchUserInfo(tokens.accessToken)
    if (this.options.enrichUserInfo) {
      userInfo = await this.options.enrichUserInfo(userInfo, tokens)
    }

    await this.options.onTokenValidated?.(ctx, userInfo, tokens)

    const subject = userInfo[this.options.subjectClaim]
    if (subject === undefined || subject === null || String(subject).length === 0) {
      throw this.callbackFailure(
        `user info has no "${this.options.subjectClaim}" field` +
          ` (fields present: ${redactPii('user info fields', Object.keys(userInfo).join(', '), this.options.showPii)})`,
      )
    }

    return { claims: this.#mapClaims(userInfo), subject: String(subject) }
  }

  async #exchangeCode(code: string, stored: RemoteAuthenticationState): Promise<RemoteAuthenticationTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.callbackURL,
    })
    if (this.options.usePKCE) {
      body.set('code_verifier', stored.codeVerifier)
    }

    const authorization: Record<string, string> = {}
    if (this.options.tokenEndpointAuthMethod === 'client_secret_basic') {
      authorization.Authorization = basicAuthHeader(this.options.clientID, this.options.clientSecret)
    } else {
      body.set('client_id', this.options.clientID)
      body.set('client_secret', this.options.clientSecret)
    }

    let response: Response
    try {
      response = await fetch(this.options.tokenEndpoint, {
        method: 'POST',
        headers: {
          ...this.options.tokenRequestHeaders,
          // Both spread last, so a caller header cannot break the exchange: the body is a
          // URLSearchParams form, so Content-Type must stay form-urlencoded, and the response
          // is always parsed as JSON. Providers differ on the Accept default — GitHub answers
          // form-encoded unless asked for JSON — so a preset that forgets it gets an
          // unparseable body.
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...authorization,
        },
        body,
        signal: AbortSignal.timeout(this.options.httpTimeoutMs),
      })
    } catch (e) {
      throw this.callbackFailure(`token exchange failed: ${(e as Error).message}`)
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      // Most often a provider that answered `application/x-www-form-urlencoded` because the
      // Accept header did not ask for JSON. Say that rather than "no access token", which
      // sends the reader looking at scopes and credentials instead of at content negotiation.
      throw this.callbackFailure(`token endpoint returned a non-JSON body (status ${response.status})`)
    }

    const tokenResponse = (parsed ?? {}) as {
      access_token?: string
      refresh_token?: string
      token_type?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }

    if (!response.ok && !tokenResponse.error) {
      throw this.callbackFailure(`token endpoint returned ${response.status}`)
    }

    if (tokenResponse.error) {
      const detail =
        tokenResponse.error_description !== undefined
          ? redactPii('error_description', tokenResponse.error_description, this.options.showPii)
          : tokenResponse.error
      throw this.callbackFailure(detail)
    }

    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      tokenType: tokenResponse.token_type,
      expiresIn: tokenResponse.expires_in,
      scope: tokenResponse.scope,
    }
  }

  async #fetchUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    try {
      return await fetchUserInfo(this.options.userInfoEndpoint, accessToken, {
        timeoutMs: this.options.httpTimeoutMs,
        headers: this.options.userInfoHeaders,
      })
    } catch (e) {
      throw this.callbackFailure((e as Error).message)
    }
  }

  #mapClaims(userInfo: Record<string, unknown>): Claim[] {
    const issuer = new URL(this.options.authorizationEndpoint).origin
    const claims = this.options.claimMapper
      ? this.options.claimMapper(userInfo)
      : defaultMapClaims(userInfo, issuer, this.options.subjectClaim, this.options.claimActions?.map)

    // Applied to a custom mapper's output too: it is an explicit "do not persist these" from
    // the caller, and a mapper that happens to emit them is not consent.
    const remove = new Set(this.options.claimActions?.remove ?? [])
    return remove.size === 0 ? claims : claims.filter(c => !remove.has(c.type))
  }
}

/**
 * Maps a user info body to claims — and *only* the fields `claimActions.map` names.
 *
 * An allowlist, deliberately, because in plain OAuth 2.0 the user info body is an unsigned JSON document
 * whose field names the provider chooses and whose field *values* are frequently whatever the user typed
 * into their provider profile. Copying it wholesale hands both to the authorization layer: a body
 * carrying `roles` lands under the default `roleClaimType` and `Principal.isInRole` reads it, so the
 * account being authenticated gets to name its own roles. Nothing about the transport prevents that —
 * unlike OIDC, there is no signature over these fields to appeal to.
 *
 * Wholesale copying additionally used to overflow the sealed session cookie past the
 * browser's ~4 KB limit on providers with large bodies, which the browser drops silently.
 *
 * Nested objects and arrays are skipped even when mapped: a claim value has to survive the JSON
 * round-trip through the session cookie and be comparable by an authorization policy, and neither holds
 * for an arbitrary object graph.
 */
function defaultMapClaims(
  userInfo: Record<string, unknown>,
  issuer: string,
  subjectField: string,
  map: Record<string, string> = {},
): Claim[] {
  const claims: Claim[] = []

  for (const [claimType, field] of Object.entries(map)) {
    const value = userInfo[field]
    // `undefined` reaches here from an enrichment that found nothing; a claim whose value is undefined is
    // worse than an absent one, because `findFirst` then returns a hit.
    if (value === undefined || value === null || typeof value === 'object') {
      continue
    }
    // The identifier is a string wherever it is read: on the ticket, as the subject of a refresh token or a
    // remember-me series, in `hasClaim('sub', id)`. A provider that numbers its users would otherwise put a number
    // in the claim and a string everywhere else.
    claims.push(new Claim(claimType, field === subjectField ? String(value) : value, issuer))
  }

  return claims
}
