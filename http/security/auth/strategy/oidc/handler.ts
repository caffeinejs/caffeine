import { randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import type { Context } from '../../../../context.js'
import { Claim, Identity, Principal } from '../../../index.js'
import { AuthenticateResult, AuthenticationTicket } from '../../ticket.js'
import { BaseAuthenticationHandler } from '../../handler.js'
import type {
  OidcAuthenticationOptions,
  OidcTokens,
  ResolvedOidcAuthenticationOptions,
  TokenEndpointAuthMethod,
} from './options.js'
import { isSafeReturnPath, resolveOidcOptions } from './options.js'
import { assertAccessTokenHash } from './_at_hash.js'
import type { OidcDiscoveryDocument } from './discovery.js'
import { fetchDiscovery } from './discovery.js'
import { generateCodeVerifier, generateCodeChallenge, selectPkceMethod } from './pkce.js'
import { encodeState, decodeState, STATE_TTL_SECONDS } from './state_store.js'
import { claimsToSession, encodeSession, decodeSession } from './session_store.js'
import { ErrOidcCallback, ErrOidcConfiguration, ErrOidcDiscovery } from './errors.js'

/**
 * Registered JWT/OIDC claims excluded from the default identity mapping.
 *
 * They describe the token itself rather than the user, and leaking them into the
 * principal risks colliding with application claim types used by policies and roles.
 */
const REGISTERED_CLAIMS = new Set([
  'iss',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'nonce',
  'azp',
  'at_hash',
  'c_hash',
  'sid',
])

/**
 * id_tokens are signed with the provider's asymmetric key — never accept a symmetric alg.
 */
const ID_TOKEN_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
]

export class OidcAuthenticationHandler extends BaseAuthenticationHandler<ResolvedOidcAuthenticationOptions> {
  readonly #name: string
  readonly #callbackPath: string
  #discovery: OidcDiscoveryDocument | undefined
  #pkceMethod: 'S256' | 'plain' | undefined
  #jwks: JWTVerifyGetKey | undefined
  #tokenAuthMethod: TokenEndpointAuthMethod | undefined

  constructor(name: string, options: OidcAuthenticationOptions) {
    // Resolving here rather than trusting the caller means there is exactly one path to a
    // configured handler: constructing one directly still validates and still defaults.
    super(resolveOidcOptions(options))
    this.#name = name
    this.#callbackPath = new URL(this.options.callbackUrl).pathname
  }

  get callbackPath(): string {
    return this.#callbackPath
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const cookie = ctx.req.cookie(this.options.sessionCookieName)
    if (!cookie) {
      return AuthenticateResult.none()
    }

    try {
      const session = await decodeSession(cookie, this.options.sessionSecret)
      const claims = session.claims.map(c => new Claim(c.type, c.value, c.issuer))
      const identity = new Identity(session.scheme, true, claims, this.options.roleClaimType)
      const principal = new Principal(true, identity)

      return AuthenticateResult.success(new AuthenticationTicket(principal, session.scheme))
    } catch (e) {
      // A cookie was presented and it did not verify — expired, tampered, or a state
      // cookie replayed as a session. That is a failure, not an absent credential.
      await this.options.onFail?.(ctx, e as Error)
      return AuthenticateResult.fail(e as Error)
    }
  }

  override async challenge(ctx: Context): Promise<void> {
    const discovery = await this.#resolveDiscovery()
    const pkceMethod = this.#pkceMethod!
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = pkceMethod === 'S256'
      ? generateCodeChallenge(codeVerifier)
      : codeVerifier

    const state = randomBytes(16).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const returnTo = ctx.req.url

    const stateCookie = await encodeState(
      { state, nonce, codeVerifier, pkceMethod, returnTo },
      this.options.sessionSecret,
    )

    const cookieOpts = this.#cookieOpts(STATE_TTL_SECONDS)
    ctx.cookie(this.options.stateCookieName, stateCookie, cookieOpts)

    const authUrl = new URL(discovery.authorization_endpoint)
    authUrl.searchParams.set('client_id', this.options.clientId)
    authUrl.searchParams.set('redirect_uri', this.options.callbackUrl)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', this.options.scopes.join(' '))
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('nonce', nonce)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', pkceMethod)

    // The hook runs only after state, nonce, PKCE and the state cookie are in place, so
    // overriding the response can never bypass the flow's security machinery.
    const authorizationUrl = authUrl.toString()
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx, authorizationUrl)
    }

    ctx.redirect(authorizationUrl, 302)
  }

  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)
  }

  /** Clears the session cookie, ending the local sign-in. */
  override revoke(ctx: Context): Promise<void> {
    ctx.deleteCookie(this.options.sessionCookieName, this.#cookieOpts())
    return Promise.resolve()
  }

  async processCallback(ctx: Context): Promise<void> {
    try {
      await this.#processCallback(ctx)
    } catch (e) {
      await this.options.onFail?.(ctx, e as Error)
      throw e
    }
  }

  async #processCallback(ctx: Context): Promise<void> {
    const code = ctx.req.query('code')
    const stateParam = ctx.req.query('state')

    // RFC 6749 §4.1.2.1: a denied or failed authorization comes back as an error
    // redirect, not an absent code. Report what the provider actually said.
    const error = ctx.req.query('error')
    if (error) {
      const description = ctx.req.query('error_description')
      throw new ErrOidcCallback(
        `Cannot process OIDC callback: provider returned "${error}"`
        + `${description ? `: ${description}` : ''}`,
      )
    }

    if (!code) {
      throw new ErrOidcCallback('Cannot process OIDC callback: missing code parameter')
    }

    const stateCookieName = this.options.stateCookieName
    const stateCookie = ctx.req.cookie(stateCookieName)
    if (!stateCookie) {
      throw new ErrOidcCallback('Cannot process OIDC callback: missing state cookie')
    }

    let stored: Awaited<ReturnType<typeof decodeState>>
    try {
      stored = await decodeState(stateCookie, this.options.sessionSecret)
    } catch {
      throw new ErrOidcCallback('Cannot process OIDC callback: invalid or expired state cookie')
    }

    if (stateParam !== stored.state) {
      throw new ErrOidcCallback('Cannot process OIDC callback: state mismatch')
    }

    ctx.deleteCookie(stateCookieName, this.#cookieOpts())

    const discovery = await this.#resolveDiscovery()

    // RFC 9207: when the provider identifies itself in the authorization response, it must
    // be the one we are about to send the code to. Defends against mix-up attacks.
    const issParam = ctx.req.query('iss')
    if (issParam !== undefined && issParam !== discovery.issuer) {
      throw new ErrOidcCallback('Cannot process OIDC callback: iss does not match the provider issuer')
    }

    const tokens = await this.#exchangeCode(code, stored.codeVerifier, discovery)

    let payload: Record<string, unknown>
    let alg: string
    try {
      const jwks = this.#resolveJwks(discovery.jwks_uri)
      const { payload: p, protectedHeader } = await jwtVerify(tokens.idToken, jwks, {
        issuer: discovery.issuer,
        audience: this.options.clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds,
      })
      payload = p as Record<string, unknown>
      alg = protectedHeader.alg
    } catch (e) {
      throw new ErrOidcCallback(`Cannot process OIDC callback: id_token validation failed: ${(e as Error).message}`)
    }

    if (payload.nonce !== stored.nonce) {
      throw new ErrOidcCallback('Cannot process OIDC callback: nonce mismatch')
    }

    // OIDC Core §2: sub is REQUIRED and is the only stable identifier for the user.
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new ErrOidcCallback('Cannot process OIDC callback: id_token is missing the sub claim')
    }

    // OIDC Core §3.1.3.7 steps 4-5: with multiple audiences, azp identifies the party the
    // token was issued for and must be this client.
    if (Array.isArray(payload.aud) && payload.aud.length > 1) {
      if (typeof payload.azp !== 'string') {
        throw new ErrOidcCallback(
          'Cannot process OIDC callback: id_token has multiple audiences but no azp claim',
        )
      }
      if (payload.azp !== this.options.clientId) {
        throw new ErrOidcCallback('Cannot process OIDC callback: id_token azp does not match clientId')
      }
    }

    // OIDC Core §3.1.3.8: OPTIONAL for the code flow, enforced whenever the provider
    // asserts it.
    if (typeof payload.at_hash === 'string' && tokens.accessToken) {
      assertAccessTokenHash(tokens.accessToken, payload.at_hash, alg)
    }

    await this.options.onTokenValidated?.(ctx, payload, tokens)

    const claims = this.options.claimMapper
      ? this.options.claimMapper(payload)
      : mapClaims(payload)

    const ttl = this.options.sessionCookieTtlSeconds
    const session = claimsToSession(claims, this.#name)
    const sessionJwt = await encodeSession(session, this.options.sessionSecret, ttl)

    ctx.cookie(this.options.sessionCookieName, sessionJwt, this.#cookieOpts(ttl))

    const fallback = this.options.defaultRedirectPath
    const returnTo = stored.returnTo
      && stored.returnTo !== this.#callbackPath
      && isSafeReturnPath(stored.returnTo)
      ? stored.returnTo
      : fallback

    ctx.redirect(returnTo, 302)
  }

  async #exchangeCode(
    code: string,
    codeVerifier: string,
    discovery: OidcDiscoveryDocument,
  ): Promise<OidcTokens> {
    const method = this.#resolveTokenAuthMethod(discovery)

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.callbackUrl,
      code_verifier: codeVerifier,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    if (method === 'client_secret_basic') {
      headers.Authorization = basicAuthHeader(this.options.clientId, this.options.clientSecret)
    } else {
      // An authenticated client does not repeat its credentials in the body, and some
      // servers reject the duplication.
      body.set('client_id', this.options.clientId)
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
      throw new ErrOidcCallback(`Cannot process OIDC callback: token exchange failed: ${(e as Error).message}`)
    }

    // A non-2xx response may carry an OAuth error object or arbitrary HTML; read the body
    // defensively so a proxy error page does not surface as a parse failure.
    const tokenResponse = await response.json().catch(() => ({})) as {
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
      throw new ErrOidcCallback(
        `Cannot process OIDC callback: token endpoint returned ${response.status}`,
      )
    }

    if (tokenResponse.error || !tokenResponse.id_token) {
      throw new ErrOidcCallback(
        `Cannot process OIDC callback: ${tokenResponse.error_description ?? tokenResponse.error ?? 'no id_token in response'}`,
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

  #resolveTokenAuthMethod(discovery: OidcDiscoveryDocument): TokenEndpointAuthMethod {
    if (this.#tokenAuthMethod) {
      return this.#tokenAuthMethod
    }

    const configured = this.options.tokenEndpointAuthMethod
    if (configured !== 'auto') {
      return this.#tokenAuthMethod = configured
    }

    const supported = discovery.token_endpoint_auth_methods_supported
    // OIDC Discovery §3: absent means client_secret_basic, which RFC 6749 §2.3.1 also
    // prefers over sending credentials in the body.
    if (!supported || supported.includes('client_secret_basic')) {
      return this.#tokenAuthMethod = 'client_secret_basic'
    }

    if (supported.includes('client_secret_post')) {
      return this.#tokenAuthMethod = 'client_secret_post'
    }

    throw new ErrOidcConfiguration(
      'Cannot configure OIDC: provider supports neither client_secret_basic nor client_secret_post '
      + `(advertised: ${supported.join(', ')})`,
    )
  }

  async #resolveDiscovery(): Promise<OidcDiscoveryDocument> {
    if (this.#discovery) {
      return this.#discovery
    }

    if (this.options.discoveryUrl) {
      const doc = await fetchDiscovery(this.options.discoveryUrl, this.options.httpTimeoutMs)

      // OIDC Discovery §4.3: the issuer in the document must match the expected issuer.
      // Without this, a compromised or misconfigured discovery endpoint gets to define the
      // issuer that every id_token is then validated against.
      if (this.options.issuer && doc.issuer !== this.options.issuer) {
        throw new ErrOidcDiscovery(
          `Cannot resolve OIDC discovery document: issuer "${doc.issuer}" does not match the configured issuer "${this.options.issuer}"`,
        )
      }

      this.#discovery = doc
    } else {
      // resolveOidcOptions() guarantees all four are present when discoveryUrl is absent.
      this.#discovery = {
        issuer: this.options.issuer as string,
        authorization_endpoint: this.options.authorizationEndpoint as string,
        token_endpoint: this.options.tokenEndpoint as string,
        jwks_uri: this.options.jwksUri as string,
      }
    }

    this.#pkceMethod = selectPkceMethod(
      this.#discovery.code_challenge_methods_supported,
      this.options.allowPlainPkce,
    )
    return this.#discovery
  }

  #resolveJwks(jwksUri: string): JWTVerifyGetKey {
    return this.#jwks ??= (
      this.options.jwksResolver?.(jwksUri) ?? createRemoteJWKSet(new URL(jwksUri)) as JWTVerifyGetKey
    )
  }

  #cookieOpts(maxAge?: number): Record<string, unknown> {
    return {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.options.secureCookie,
      ...(maxAge !== undefined ? { maxAge } : {}),
    }
  }
}

/**
 * Encodes a value with the `application/x-www-form-urlencoded` serializer.
 *
 * Uses `URLSearchParams` rather than `encodeURIComponent`, which leaves `!~'()` unencoded
 * and would produce credentials a strict authorization server rejects.
 */
function formUrlEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2)
}

/**
 * Builds the HTTP Basic credentials for token endpoint client authentication.
 *
 * RFC 6749 §2.3.1 requires both the client id and secret to be form-urlencoded *before*
 * being joined and base64-encoded.
 */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`
  return `Basic ${Buffer.from(credentials).toString('base64')}`
}

function mapClaims(payload: Record<string, unknown>): Claim[] {
  const issuer = typeof payload.iss === 'string' ? payload.iss : ''
  return Object.entries(payload)
    .filter(([type]) => !REGISTERED_CLAIMS.has(type))
    .map(([type, value]) => new Claim(type, value, issuer))
}
