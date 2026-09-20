import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTVerifyGetKey } from 'jose'

import type { Context } from '../../../context.js'
import { Claim } from '../../index.js'
import { basicAuthHeader, type TokenEndpointAuthMethod } from '../internal/remote/client_auth.js'
import { RemoteAuthenticationHandler } from '../internal/remote/handler.js'
import type { RemoteAuthenticationIdentity } from '../internal/remote/handler.js'
import { redactPii, redactPiiList } from '../internal/remote/pii.js'
import { selectPKCEMethod } from '../internal/remote/pkce.js'
import type { RemoteAuthenticationState } from '../internal/remote/state_store.js'
import { fetchUserInfo } from '../internal/remote/userinfo.js'
import { REGISTERED_CLAIMS } from '../registered_claims.js'
import { assertAccessTokenHash } from './_at_hash.js'
import { fetchDiscovery } from './discovery.js'
import type { OIDCDiscoveryDocument } from './discovery.js'
import { ErrOIDCCallback, ErrOIDCConfiguration, ErrOIDCDiscovery, ErrOIDCSession } from './errors.js'
import { resolveOIDCOptions } from './options.js'
import type { OIDCAuthenticationOptions, OIDCTokens, ResolvedOIDCAuthenticationOptions } from './options.js'

/**
 * id_tokens are signed with the provider's asymmetric key — never accept a symmetric alg.
 */
/** How long a refresh of the discovery document that failed is left alone before it is tried again. */
const DISCOVERY_RETRY_MS = 30_000

const ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512']

export class OIDCAuthenticationHandler extends RemoteAuthenticationHandler<ResolvedOIDCAuthenticationOptions> {
  #discovery: OIDCDiscoveryDocument | undefined
  #pkceMethod: 'S256' | 'plain' | undefined
  #jwks: JWTVerifyGetKey | undefined
  #tokenAuthMethod: TokenEndpointAuthMethod | undefined
  #discoveryFetchedAt = 0
  #discoveryRetryAt = 0
  #inflight: Promise<OIDCDiscoveryDocument> | undefined

  constructor(name: string, options: OIDCAuthenticationOptions) {
    // Resolving here rather than trusting the caller means there is exactly one path to a
    // configured handler: constructing one directly still validates and still defaults.
    super(name, resolveOIDCOptions(options, name))
  }

  protected override callbackError(message: string): Error {
    return new ErrOIDCCallback(message)
  }

  protected override sessionError(message: string): Error {
    return new ErrOIDCSession(message)
  }

  // ---------------------------------------------------------------- protocol seams

  protected override async resolveIssuer(): Promise<string> {
    return (await this.#resolveDiscovery()).issuer
  }

  protected override async resolveAuthorizationEndpoint(): Promise<string> {
    return (await this.#resolveDiscovery()).authorization_endpoint
  }

  /**
   * Never `none`: OpenID Connect flows here always carry PKCE, and `selectPKCEMethod` throws
   * rather than degrade when a provider advertises neither method.
   */
  protected override async resolvePKCEMethod(): Promise<'S256' | 'plain'> {
    await this.#resolveDiscovery()
    return this.#pkceMethod!
  }

  /**
   * The nonce is guarded as well: it binds the id_token to this authorization request, and the
   * callback rejects a token whose nonce does not match the state cookie. A hook that changed
   * it would break every sign-in; one that removed it would remove the replay defence.
   */
  protected override guardedAuthorizationParams(): string[] {
    return [...super.guardedAuthorizationParams(), 'nonce']
  }

  /** OIDC Core §3.1.2.1: the nonce binds the id_token to this authorization request. */
  protected override authorizationParams(args: { nonce: string }): Record<string, string> {
    const params: Record<string, string> = {
      // Spread first so the nonce below wins outright; the base drops any remaining entry
      // that would overwrite a guarded parameter it has already set.
      ...this.options.extraAuthorizationParams,
      nonce: args.nonce,
    }

    if (this.options.prompt) {
      params.prompt = this.options.prompt
    }
    if (this.options.loginHint) {
      params.login_hint = this.options.loginHint
    }
    if (this.options.acrValues?.length) {
      params.acr_values = this.options.acrValues.join(' ')
    }
    if (this.options.maxAgeSeconds !== undefined) {
      params.max_age = String(this.options.maxAgeSeconds)
    }

    return params
  }

  protected override async exchangeAndBuildIdentity(
    ctx: Context,
    code: string,
    stored: RemoteAuthenticationState,
  ): Promise<RemoteAuthenticationIdentity> {
    // The base has already re-checked `stored.issuer` against `resolveIssuer()` (the discovery
    // issuer) before calling this, so a reconfigured provider is rejected there. This resolve
    // returns the same cached document.
    const discovery = await this.#resolveDiscovery()

    // RFC 9207 defends against mix-up attacks by having the provider identify itself in the
    // authorization response. It is required only when the provider advertises support:
    // demanding it unconditionally would break every IdP that has not implemented the RFC,
    // and treating it as optional where it *is* advertised would let an attacker suppress it.
    const issParam = ctx.req.query('iss')
    if (discovery.authorization_response_iss_parameter_supported === true && issParam === undefined) {
      throw this.callbackFailure('missing iss parameter')
    }
    if (issParam !== undefined && (issParam !== discovery.issuer || issParam !== stored.issuer)) {
      throw this.callbackFailure('iss does not match the provider issuer')
    }

    const tokens = await this.#exchangeCode(code, stored.codeVerifier, discovery)

    let payload: Record<string, unknown>
    let alg: string
    try {
      const jwks = this.#resolveJwks(discovery.jwks_uri)
      const { payload: p, protectedHeader } = await jwtVerify(tokens.idToken, jwks, {
        issuer: discovery.issuer,
        audience: this.options.clientID,
        algorithms: ID_TOKEN_ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds,
        // OIDC Core §2: both are REQUIRED. jose checks a time claim only when there is one, so an id_token without
        // `exp` would otherwise be good forever.
        requiredClaims: ['exp', 'iat'],
      })
      payload = p as Record<string, unknown>
      alg = protectedHeader.alg
    } catch (e) {
      throw this.callbackFailure(`id_token validation failed: ${(e as Error).message}`)
    }

    const showPii = this.options.showPii

    if (payload.nonce !== stored.nonce) {
      throw this.callbackFailure(
        'nonce mismatch' +
          ` (expected ${redactPii('nonce', stored.nonce, showPii)},` +
          ` received ${redactPii('nonce', payload.nonce, showPii)})`,
      )
    }

    // OIDC Core §2: sub is REQUIRED and is the only stable identifier for the user.
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw this.callbackFailure(
        'id_token is missing the sub claim' +
          ` (claims present: ${redactPiiList('claims', Object.keys(payload), showPii)})`,
      )
    }

    // OIDC Core §2: auth_time is REQUIRED in the id_token when max_age was requested. Sending
    // the parameter and not checking the answer is worse than never sending it — it reads as
    // a freshness control while a provider that ignores max_age passes silently.
    if (this.options.maxAgeSeconds !== undefined) {
      if (typeof payload.auth_time !== 'number') {
        throw this.callbackFailure('id_token has no auth_time claim, which is required when max_age is requested')
      }

      const age = Math.floor(Date.now() / 1000) - payload.auth_time
      if (age > this.options.maxAgeSeconds + this.options.clockToleranceSeconds) {
        throw this.callbackFailure(
          `the provider authenticated the user ${age}s ago, older than the requested max_age` +
            ` of ${this.options.maxAgeSeconds}s`,
        )
      }
    }

    // OIDC Core §3.1.3.7 steps 4-5: with multiple audiences an azp is required, and whenever one is present it
    // names the party the token was issued to, which has to be this client.
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && typeof payload.azp !== 'string') {
      throw this.callbackFailure('id_token has multiple audiences but no azp claim')
    }
    if (payload.azp !== undefined && payload.azp !== this.options.clientID) {
      throw this.callbackFailure(
        'id_token azp does not match clientID' + ` (azp ${redactPii('azp', payload.azp, showPii)})`,
      )
    }

    // OIDC Core §3.1.3.8: OPTIONAL for the code flow, enforced whenever the provider
    // asserts it.
    if (typeof payload.at_hash === 'string' && tokens.accessToken) {
      assertAccessTokenHash(tokens.accessToken, payload.at_hash, alg, showPii)
    }

    // Fires with the id_token payload alone, before any UserInfo merge — the parameter is
    // documented as the id_token's claims and must not quietly become something broader.
    await this.options.onTokenValidated?.(ctx, payload, tokens)

    const merged = this.options.getClaimsFromUserInfoEndpoint
      ? await this.#mergeUserInfo(payload, tokens, discovery)
      : payload

    // `claimActions.remove` applies to a custom mapper's output too: it is an explicit "do not
    // persist these" from the caller, and a mapper that happens to emit them is not consent.
    // Registered claims are left alone here — `claimMapper` is documented as the full
    // override, so a mapper that deliberately emits `sid` or `azp` gets to keep it.
    const claims = removeClaims(
      this.options.claimMapper ? this.options.claimMapper(merged) : mapClaims(merged),
      this.options.claimActions?.remove,
    )

    // `payload.sub` rather than a mapped claim — a claimMapper may legitimately drop it, and
    // without a subject the session could never be revoked by user.
    return {
      claims,
      subject: payload.sub,
      tokens: this.options.saveTokens ? tokens : undefined,
    }
  }

  /**
   * Ends the session at the provider as well as here (OpenID Connect RP-Initiated Logout §2).
   *
   * `revoke()` alone only ends the session on this side. The provider's own session survives,
   * so the next sign-in silently re-authenticates without a prompt and the user is left
   * believing they signed out — on a shared machine, the next person is one click from their
   * account.
   *
   * The local session is dropped first: if the redirect fails or the user abandons it midway,
   * the outcome is a signed-out user, not a live session and a false sense of security.
   *
   * Reached through `AuthenticationService.signOut(ctx, scheme)`.
   *
   * @throws ErrOIDCConfiguration when no end-session endpoint is configured and the provider advertises none. The
   * session here is gone by then.
   */
  override async signOut(ctx: Context): Promise<void> {
    // Read the id_token before revoking — revocation is what makes the ticket unreachable.
    const idToken = (await this.currentTicket(ctx))?.tokens?.idToken

    // Local sign-out first and unconditionally, as the doc above promises. Whatever happens
    // resolving the provider endpoint below, the session on this side is already gone: a
    // provider whose discovery endpoint is down must never be the reason a user stays signed
    // in here.
    await this.revoke(ctx)

    // Prefer the explicitly configured endpoint, and only reach for discovery when it is
    // absent — a configured logout URL must not drag in a discovery fetch that can fail.
    const endpoint = this.options.endSessionEndpoint ?? (await this.#resolveDiscovery()).end_session_endpoint
    if (!endpoint) {
      throw new ErrOIDCConfiguration('Cannot sign out: the provider advertises no end_session_endpoint')
    }

    const url = new URL(endpoint)
    url.searchParams.set('client_id', this.options.clientID)
    // RECOMMENDED rather than REQUIRED by the spec, and unavailable without `saveTokens`.
    // Providers that insist on it will say so; sending nothing is better than sending a
    // token belonging to some other session.
    if (idToken) {
      url.searchParams.set('id_token_hint', idToken)
    }
    if (this.options.postLogoutRedirectURI) {
      url.searchParams.set('post_logout_redirect_uri', this.options.postLogoutRedirectURI)
    }

    ctx.redirect(url.toString(), 302)
  }

  /**
   * Supplements the id_token with the UserInfo endpoint (OIDC Core §5.3).
   *
   * The id_token wins every collision. It arrived signed by the provider and verified against
   * the JWKS; the UserInfo body is an ordinary JSON response authenticated only by the bearer
   * token, so letting it overwrite `sub`, `aud` or `exp` would trade a cryptographic assertion
   * for a weaker one.
   */
  async #mergeUserInfo(
    payload: Record<string, unknown>,
    tokens: OIDCTokens,
    discovery: OIDCDiscoveryDocument,
  ): Promise<Record<string, unknown>> {
    const endpoint = this.options.userInfoEndpoint ?? discovery.userinfo_endpoint
    if (!endpoint) {
      throw this.callbackFailure(
        'getClaimsFromUserInfoEndpoint is set but the provider advertises no userinfo_endpoint',
      )
    }

    if (!tokens.accessToken) {
      throw this.callbackFailure('getClaimsFromUserInfoEndpoint is set but the token response carried no access token')
    }

    let userInfo: Record<string, unknown>
    try {
      userInfo = await fetchUserInfo(endpoint, tokens.accessToken, {
        timeoutMs: this.options.httpTimeoutMs,
      })
    } catch (e) {
      throw this.callbackFailure((e as Error).message)
    }

    // OIDC Core §5.3.2: the sub in the UserInfo response MUST be verified to match the
    // id_token's, and the response MUST NOT be used otherwise. A mismatch means the body
    // describes a different user than the one who just authenticated — the exact confusion
    // that would let one account's claims be attached to another's session.
    if (userInfo.sub !== payload.sub) {
      throw this.callbackFailure(
        'user info sub does not match the id_token sub' +
          ` (id_token ${redactPii('sub', payload.sub, this.options.showPii)},` +
          ` user info ${redactPii('sub', userInfo.sub, this.options.showPii)})`,
      )
    }

    return { ...userInfo, ...payload }
  }

  async #exchangeCode(code: string, codeVerifier: string, discovery: OIDCDiscoveryDocument): Promise<OIDCTokens> {
    const method = this.#resolveTokenAuthMethod(discovery)

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.callbackURL,
      code_verifier: codeVerifier,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    if (method === 'client_secret_basic') {
      headers.Authorization = basicAuthHeader(this.options.clientID, this.options.clientSecret)
    } else {
      // An authenticated client does not repeat its credentials in the body, and some
      // servers reject the duplication.
      body.set('client_id', this.options.clientID)
      body.set('client_secret', this.options.clientSecret)
    }

    let response: Response
    try {
      response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.options.httpTimeoutMs),
      })
    } catch (e) {
      throw this.callbackFailure(`token exchange failed: ${(e as Error).message}`)
    }

    // A non-2xx response may carry an OAuth error object or arbitrary HTML; read the body
    // defensively so a proxy error page does not surface as a parse failure. The `?? {}` also
    // covers a literal `null` body, which parses without throwing and would otherwise make the
    // `.error` access below a TypeError — the OAuth2 handler guards the same spot the same way.
    const tokenResponse = ((await response.json().catch(() => ({}))) ?? {}) as {
      id_token?: string
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

    if (tokenResponse.error || !tokenResponse.id_token) {
      // error_description is provider-authored free text of unconstrained content, so it is
      // treated as potentially carrying user data.
      const detail =
        tokenResponse.error_description !== undefined
          ? redactPii('error_description', tokenResponse.error_description, this.options.showPii)
          : (tokenResponse.error ?? 'no id_token in response')
      throw this.callbackFailure(detail)
    }

    // OIDC Core §3.1.3.3: the token type is Bearer, compared case-insensitively. Anything else is a credential this
    // handler would go on to present, at the UserInfo endpoint, in a way it was not issued to be presented.
    const tokenType: unknown = tokenResponse.token_type
    if (tokenResponse.access_token !== undefined && !(typeof tokenType === 'string' && /^bearer$/i.test(tokenType))) {
      throw this.callbackFailure(
        typeof tokenType === 'string'
          ? `token endpoint returned an access token of type "${tokenType}"`
          : 'token endpoint returned an access token without a token_type',
      )
    }

    return {
      idToken: tokenResponse.id_token,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      tokenType: tokenResponse.token_type,
      expiresIn: tokenResponse.expires_in,
      scope: tokenResponse.scope,
    }
  }

  #resolveTokenAuthMethod(discovery: OIDCDiscoveryDocument): TokenEndpointAuthMethod {
    if (this.#tokenAuthMethod) {
      return this.#tokenAuthMethod
    }

    const configured = this.options.tokenEndpointAuthMethod
    if (configured !== 'auto') {
      return (this.#tokenAuthMethod = configured)
    }

    const supported = discovery.token_endpoint_auth_methods_supported
    // OIDC Discovery §3: absent means client_secret_basic, which RFC 6749 §2.3.1 also
    // prefers over sending credentials in the body.
    if (!supported || supported.includes('client_secret_basic')) {
      return (this.#tokenAuthMethod = 'client_secret_basic')
    }

    if (supported.includes('client_secret_post')) {
      return (this.#tokenAuthMethod = 'client_secret_post')
    }

    throw new ErrOIDCConfiguration(
      'Cannot configure OIDC: provider supports neither client_secret_basic nor client_secret_post ' +
        `(advertised: ${supported.join(', ')})`,
    )
  }

  /**
   * The discovery document, fetched at most once per staleness window.
   *
   * Single-flight rather than a plain memo. `challenge()` resolves the issuer, the
   * authorization endpoint and the PKCE method concurrently, and every request that arrives
   * after the TTL expires enters here too — without the in-flight promise each of those
   * becomes its own HTTP fetch, so a busy handler stampedes the provider on every refresh.
   *
   * It also removes a race rather than merely an inefficiency: the block below clears
   * `#pkceMethod`, `#tokenAuthMethod` and `#jwks` and repopulates them across an `await`, so
   * two concurrent entries could have one read a field the other had just cleared.
   */
  #resolveDiscovery(): Promise<OIDCDiscoveryDocument> {
    if (this.#discovery && (!this.#discoveryIsStale() || Date.now() < this.#discoveryRetryAt)) {
      return Promise.resolve(this.#discovery)
    }

    return (this.#inflight ??= this.#refreshDiscovery().finally(() => {
      this.#inflight = undefined
    }))
  }

  /**
   * Fetches the document again, and goes on with the one in hand when the provider cannot be asked.
   *
   * A document that was good an hour ago is a far better guide than none: endpoints move rarely, and a provider
   * whose discovery endpoint is briefly down is otherwise a sign-in outage here. The next attempt waits a little,
   * so a provider that is struggling is not asked again by every request.
   *
   * Only an outage is ridden out. A document that was fetched and then refused — another issuer, no usable PKCE
   * method, a plain-http endpoint — fails the request: that is a provider saying something new, not saying nothing.
   */
  async #refreshDiscovery(): Promise<OIDCDiscoveryDocument> {
    try {
      return await this.#fetchDiscovery()
    } catch (e) {
      if (this.#discovery === undefined || !(e instanceof ErrOIDCDiscovery && e.unreachable)) {
        throw e
      }

      this.#discoveryRetryAt = Date.now() + DISCOVERY_RETRY_MS

      return this.#discovery
    }
  }

  async #fetchDiscovery(): Promise<OIDCDiscoveryDocument> {
    let doc: OIDCDiscoveryDocument
    if (this.options.discoveryURL) {
      doc = await fetchDiscovery(this.options.discoveryURL, this.options.httpTimeoutMs)

      // OIDC Discovery §4.3: the issuer in the document must match the expected issuer.
      // Without this, a compromised or misconfigured discovery endpoint gets to define the
      // issuer that every id_token is then validated against.
      if (this.options.issuer && doc.issuer !== this.options.issuer) {
        throw new ErrOIDCDiscovery(
          `Cannot resolve OIDC discovery document: issuer "${doc.issuer}" does not match the configured issuer "${this.options.issuer}"`,
        )
      }
    } else {
      // resolveOIDCOptions() guarantees all four are present when discoveryURL is absent.
      doc = {
        issuer: this.options.issuer as string,
        authorization_endpoint: this.options.authorizationEndpoint as string,
        token_endpoint: this.options.tokenEndpoint as string,
        jwks_uri: this.options.jwksURI as string,
      }
    }

    // Derive everything the document implies before committing any of it. `selectPKCEMethod`
    // can reject a provider that advertises no usable method, and if that throw landed after
    // `#discovery` were already assigned, the document would sit cached as fresh with
    // `#pkceMethod` left undefined — every later challenge would then skip re-derivation and
    // send a PKCE-less request. Nothing below this line can throw.
    const pkceMethod = selectPKCEMethod(doc.code_challenge_methods_supported, this.options.allowPlainPKCE)

    // The JWKS resolver is discarded only when the endpoint actually moved. `createRemoteJWKSet`
    // keeps its own rotation cache and refetches on an unknown `kid`, so clearing it on every
    // refresh — providers rotate keys, not URIs — just forces a cold fetch after each rollover.
    // A stale resolver against a retired `jwks_uri` is the real hazard, and a changed URI is
    // exactly what this catches.
    if (doc.jwks_uri !== this.#discovery?.jwks_uri) {
      this.#jwks = undefined
    }
    this.#tokenAuthMethod = undefined
    this.#pkceMethod = pkceMethod
    this.#discovery = doc
    this.#discoveryFetchedAt = Date.now()
    return doc
  }

  /**
   * Manually configured endpoints never go stale — there is nothing to refetch. A TTL of `0`
   * means always refetch, which is why the comparison is not `<=`.
   */
  #discoveryIsStale(): boolean {
    if (!this.options.discoveryURL) {
      return false
    }

    const ttlMs = this.options.discoveryCacheTtlSeconds * 1000
    return ttlMs === 0 || Date.now() - this.#discoveryFetchedAt >= ttlMs
  }

  #resolveJwks(jwksURI: string): JWTVerifyGetKey {
    return (this.#jwks ??=
      this.options.jwksResolver?.(jwksURI) ??
      (createRemoteJWKSet(new URL(jwksURI), { timeoutDuration: this.options.httpTimeoutMs }) as JWTVerifyGetKey))
  }
}

function mapClaims(payload: Record<string, unknown>): Claim[] {
  const issuer = typeof payload.iss === 'string' ? payload.iss : ''
  return Object.entries(payload)
    .filter(([type]) => !REGISTERED_CLAIMS.has(type))
    .map(([type, value]) => new Claim(type, value, issuer))
}

/** Drops the named claim types, applied whichever mapper produced the claims. */
function removeClaims(claims: Claim[], remove: readonly string[] = []): Claim[] {
  if (remove.length === 0) {
    return claims
  }

  const removed = new Set(remove)
  return claims.filter(c => !removed.has(c.type))
}
