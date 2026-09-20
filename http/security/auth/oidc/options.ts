import type { JWTVerifyGetKey } from 'jose'

import type { Context } from '../../../context.js'
import type { Claim } from '../../index.js'
import type { TokenEndpointAuthMethod } from '../internal/remote/client_auth.js'
import {
  assertSecureEndpoint,
  cookieName,
  defaultSecureCookie,
  isSafeReturnPath,
  DEFAULT_HTTP_TIMEOUT_MS,
  MIN_SESSION_SECRET_LENGTH,
} from '../internal/remote/config.js'
import type { RemoteChallengeMode } from '../internal/remote/handler.js'
import type { RemoteAuthenticationTicketStore } from '../internal/remote/ticket_store.js'
import { ErrOIDCConfiguration } from './errors.js'

/** The `openid` scope is REQUIRED by OpenID Connect Core — without it no id_token is issued. */
const REQUIRED_SCOPE = 'openid'

/**
 * Data minimisation by default: `openid` alone yields essentially `sub`, and `mapClaims`
 * strips registered claims, so nothing personal reaches the cookie unless it was asked for.
 * Opt back in explicitly, e.g. `opts.scopes('openid', 'email')`.
 */
const DEFAULT_SCOPES = [REQUIRED_SCOPE]

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/** Raw tokens from the token endpoint, handed to `onTokenValidated`. */
export interface OIDCTokens {
  /** The raw id_token JWT — required as `id_token_hint` for RP-initiated logout. */
  idToken: string
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
  scope?: string
}

/**
 * Fields `resolveOIDCOptions()` fills in when the caller omits them.
 *
 * Doubles as the checklist the resolver must satisfy: because it returns
 * `ResolvedOIDCAuthenticationOptions`, forgetting one of these is a compile error.
 */
type DefaultedKey =
  | 'defaultRedirectPath'
  | 'scopes'
  | 'sessionCookieName'
  | 'stateCookieName'
  | 'sessionCookieTtlSeconds'
  | 'secureCookie'
  | 'roleClaimType'
  | 'allowPlainPKCE'
  | 'clockToleranceSeconds'
  | 'httpTimeoutMs'
  | 'discoveryCacheTtlSeconds'
  | 'tokenEndpointAuthMethod'
  | 'showPii'
  | 'challengeMode'
  | 'getClaimsFromUserInfoEndpoint'
  | 'saveTokens'

/**
 * The canonical option shape, as consumed by the handler.
 *
 * Every defaulted field is required here so the handler never needs a `!` or a `??`
 * fallback — each such fallback is an opportunity to silently fail open.
 */
export interface ResolvedOIDCAuthenticationOptions {
  clientID: string
  clientSecret: string

  discoveryURL?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  jwksURI?: string
  issuer?: string

  callbackURL: string
  defaultRedirectPath: string
  scopes: string[]

  sessionSecret: string
  sessionCookieName: string
  sessionCookieTtlSeconds: number
  stateCookieName: string
  secureCookie: boolean

  roleClaimType: string
  /** Permits the `plain` PKCE method against providers that do not advertise S256. */
  allowPlainPKCE: boolean
  /** Leeway for provider clock drift when validating id_token time claims. */
  clockToleranceSeconds: number
  /** Ceiling on discovery and token-exchange requests, so a hung provider cannot pin a request. */
  httpTimeoutMs: number
  /**
   * How long a fetched discovery document stays authoritative. `0` refetches every time.
   *
   * Providers rotate endpoints and change advertised capabilities; caching for the process
   * lifetime means a handler can keep using an endpoint the issuer has retired.
   *
   * When the provider cannot be reached for a refresh, the document in hand keeps being used and the fetch is
   * tried again half a minute later. A document that was fetched and refused fails the request instead.
   */
  discoveryCacheTtlSeconds: number
  /** `auto` negotiates from discovery, preferring `client_secret_basic`. */
  tokenEndpointAuthMethod: TokenEndpointAuthMethod | 'auto'
  /**
   * Reveals personally identifiable information in server-side diagnostics.
   *
   * Scoped to this strategy rather than a process-wide static. Off by
   * default: error messages carry a redaction notice instead of claim values. Turning it on
   * affects only the logged `message` — `RemoteAuthenticationError.publicMessage`, all the client can see,
   * never carries user data either way.
   */
  showPii: boolean
  challengeMode: RemoteChallengeMode
  /**
   * The path of the route that starts a sign-in, on the origin of `callbackURL`. `<callback path>/login` unless set.
   *
   * A challenge that cannot redirect answers `401` with this URL as `loginURL`. Nothing is started until a browser
   * goes there.
   */
  loginPath?: string

  /**
   * Post-mapping claim surgery.
   *
   * Applied after registered claims are stripped. Use it to keep specific fields out of the
   * session when a broader scope was requested — `claimMapper` remains the full override.
   */
  claimActions?: { remove?: string[] }

  /**
   * Supplements the id_token with a call to the UserInfo endpoint (OIDC Core §5.3).
   *
   * Off by default: it costs a request per
   * sign-in, and many providers already return everything in the id_token. It earns its keep
   * where a provider keeps the id_token minimal — Okta and Auth0 both omit `email` and `name`
   * from the id_token unless asked.
   *
   * The id_token stays authoritative: UserInfo fields are merged *underneath* it, so a
   * response cannot overwrite a claim that arrived cryptographically signed.
   */
  getClaimsFromUserInfoEndpoint: boolean

  /**
   * The UserInfo endpoint, when discovery does not advertise one.
   *
   * Normally taken from the discovery document's `userinfo_endpoint`. Set this only for a
   * manually configured provider, or to pin the endpoint against a document that advertises
   * one this deployment does not trust.
   */
  userInfoEndpoint?: string

  /**
   * Keeps the provider's tokens on the server-side ticket.
   *
   * Required for `signOut()`, which needs the id_token as `id_token_hint`. Refusing to
   * configure without a `ticketStore` is deliberate: the alternative home for the tokens is the
   * session cookie, and a refresh token is a long-lived credential that does not belong in
   * something the client holds.
   */
  saveTokens: boolean

  /**
   * Where the provider returns the user after ending its session.
   *
   * Must be registered with the provider — an unregistered value is rejected outright by most
   * IdPs, which is the intended behaviour: it stops the logout redirect being turned into an
   * open redirect.
   */
  postLogoutRedirectURI?: string

  /**
   * The logout endpoint, when discovery does not advertise one.
   *
   * Normally taken from the document's `end_session_endpoint`.
   */
  endSessionEndpoint?: string

  /**
   * OIDC Core §3.1.2.1 `prompt`. `login` forces re-authentication, `none` requires that no UI
   * be shown, `consent` and `select_account` request those screens.
   */
  prompt?: 'none' | 'login' | 'consent' | 'select_account'

  /** A hint at the account to use — usually the email typed on a preceding screen. */
  loginHint?: string

  /** Requested authentication context class references, most preferred first. */
  acrValues?: string[]

  /**
   * The maximum age, in seconds, of the user's authentication at the provider.
   *
   * OIDC Core §2 makes `auth_time` REQUIRED in the id_token once this is sent, and the handler
   * enforces it: an id_token with no `auth_time`, or one older than this, is rejected.
   * Requesting a fresh authentication and then not checking that one happened is weaker than
   * never asking, because it looks like a control while enforcing nothing.
   */
  maxAgeSeconds?: number

  /**
   * Extra authorization parameters, for provider-specific extensions.
   *
   * Cannot replace a protocol parameter: an entry named `client_id`, `redirect_uri`, `state`,
   * `nonce` or `code_challenge` is dropped rather than honoured. An extras bag able to change
   * where the authorization code is delivered would be a way to misconfigure the flow into
   * handing codes to someone else.
   */
  extraAuthorizationParams?: Record<string, string>

  /**
   * Inspects and adjusts the authorization URL before the redirect.
   *
   * Receives a throwaway copy of the URL. Only its changes to non-guarded query parameters are
   * adopted: add `ui_locales`, adjust `prompt`. Two things it cannot change, because it never
   * holds the real URL — the endpoint (`origin`/`pathname`; a per-request endpoint belongs in
   * configuration, not here) and the guarded protocol parameters (`client_id`, `redirect_uri`,
   * `state`, `nonce`, `code_challenge` and the rest), which are always taken from the handler.
   */
  onRedirectToProvider?: (ctx: Context, url: URL) => Promise<void> | void

  /**
   * Holds sessions server-side; the cookie then carries only an opaque key.
   *
   * Without one the sealed cookie is the session
   * and cannot be revoked before its TTL expires. Deliberately not defaulted, and no
   * production implementation ships: supply one backed by whatever the deployment already
   * shares. `TestOIDCTicketStore` in `@caffeinejs/testing` covers tests.
   */
  ticketStore?: RemoteAuthenticationTicketStore

  /**
   * Fires after the id_token is fully validated, with the raw tokens from the exchange.
   *
   * The tokens are intentionally not persisted in the session cookie: refresh tokens are
   * long-lived, high-value credentials and the cookie is client-side and size-capped.
   * Store them server-side here if the application needs them.
   */
  onTokenValidated?: (ctx: Context, idTokenPayload: Record<string, unknown>, tokens: OIDCTokens) => Promise<void> | void
  /**
   * Called when a session cookie is refused and when a callback fails, with the diagnostic error.
   *
   * On a failed callback it may answer the request — `ctx.redirect('/sign-in?failed=1')` — and what it answered is
   * what goes out. Left unanswered, the callback responds `400` with a generic body.
   */
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  /**
   * Shapes the challenge response. Receives the fully built authorization URL — state,
   * nonce and PKCE have already been generated and the state cookie already set, so the
   * flow stays correct no matter what the hook does. Use it to return `401` with the
   * login URL for SPA clients instead of the default `302`.
   */
  onChallenge?: (ctx: Context, authorizationURL: string) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
  claimMapper?: (idTokenPayload: Record<string, unknown>) => Claim[]

  jwksResolver?: (jwksURI: string) => JWTVerifyGetKey
}

/** What the caller supplies — the defaulted fields are optional. */
export type OIDCAuthenticationOptions = PartialBy<ResolvedOIDCAuthenticationOptions, DefaultedKey>

function withRequiredScope(scopes: string[]): string[] {
  return scopes.includes(REQUIRED_SCOPE) ? [...scopes] : [REQUIRED_SCOPE, ...scopes]
}

export function resolveOIDCOptions(
  input: OIDCAuthenticationOptions,
  scheme: string,
): ResolvedOIDCAuthenticationOptions {
  const { clientID, clientSecret, sessionSecret, callbackURL } = input

  if (!clientID) {
    throw new ErrOIDCConfiguration('Cannot configure OIDC: clientID is required')
  }
  if (!clientSecret) {
    throw new ErrOIDCConfiguration('Cannot configure OIDC: clientSecret is required')
  }
  if (!sessionSecret) {
    throw new ErrOIDCConfiguration('Cannot configure OIDC: sessionSecret is required')
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ErrOIDCConfiguration(
      `Cannot configure OIDC: sessionSecret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    )
  }
  if (!callbackURL) {
    throw new ErrOIDCConfiguration('Cannot configure OIDC: callbackURL is required')
  }

  let callback: URL
  try {
    callback = new URL(callbackURL)
  } catch {
    throw new ErrOIDCConfiguration(`Cannot configure OIDC: callbackURL "${callbackURL}" is not a valid URL`)
  }

  const hasDiscovery = Boolean(input.discoveryURL)
  const hasManual = Boolean(input.authorizationEndpoint && input.tokenEndpoint && input.jwksURI && input.issuer)

  if (!hasDiscovery && !hasManual) {
    throw new ErrOIDCConfiguration(
      'Cannot configure OIDC: provide discoveryURL or all of authorizationEndpoint, tokenEndpoint, jwksURI, and issuer',
    )
  }

  // Without a pinned issuer the discovery document defines the issuer that every id_token is
  // then validated against, so a compromised or swapped document validates its own tokens.
  if (hasDiscovery && !input.issuer) {
    throw new ErrOIDCConfiguration('Cannot configure OIDC: issuer is required when discoveryURL is set')
  }

  // Every configured protocol endpoint must be TLS-protected. Endpoints that arrive later
  // from the discovery document are checked again when that document is resolved.
  const endpoints: Array<[string, string | undefined]> = [
    // The callback receives the authorization code — over plain http it is interceptable.
    ['callbackURL', callbackURL],
    ['discoveryURL', input.discoveryURL],
    ['authorizationEndpoint', input.authorizationEndpoint],
    ['tokenEndpoint', input.tokenEndpoint],
    ['jwksURI', input.jwksURI],
    ['issuer', input.issuer],
    // The UserInfo request carries the access token in an Authorization header.
    ['userInfoEndpoint', input.userInfoEndpoint],
    // The logout request carries the id_token as `id_token_hint`.
    ['endSessionEndpoint', input.endSessionEndpoint],
    ['postLogoutRedirectURI', input.postLogoutRedirectURI],
  ]
  for (const [label, value] of endpoints) {
    if (value) {
      assertSecureEndpoint(label, value)
    }
  }

  const defaultRedirectPath = input.defaultRedirectPath ?? '/'
  if (!isSafeReturnPath(defaultRedirectPath)) {
    throw new ErrOIDCConfiguration(
      `Cannot configure OIDC: defaultRedirectPath "${defaultRedirectPath}" must be a same-site absolute path`,
    )
  }

  // Without a store the only place left to put the tokens is the session cookie, and a
  // refresh token is the longest-lived credential the flow produces. Refusing here rather
  // than dropping them silently: a sign-out that needs `id_token_hint` would otherwise fail
  // at logout time, long after the misconfiguration was introduced.
  if (input.saveTokens && !input.ticketStore) {
    throw new ErrOIDCConfiguration('Cannot configure OIDC: saveTokens requires a ticketStore')
  }

  const secureCookie = input.secureCookie ?? defaultSecureCookie(callback.href)

  return {
    ...input,
    clientID,
    clientSecret,
    sessionSecret,
    callbackURL,
    defaultRedirectPath,
    // The openid scope is REQUIRED — re-add it if the caller replaced the defaults.
    scopes: withRequiredScope(input.scopes ?? DEFAULT_SCOPES),
    secureCookie,
    // Always namespaced by strategy, not only when several are registered: two handlers on
    // default names would otherwise overwrite each other's cookies, and a deployment that
    // adds a second IdP later would break the first without touching its configuration.
    // __Host- binds the cookie to the exact origin with Path=/ and no Domain, which the
    // handler already satisfies. The prefix is only legal on a Secure cookie.
    sessionCookieName: input.sessionCookieName ?? cookieName('session', scheme, secureCookie, 'oidc'),
    stateCookieName: input.stateCookieName ?? cookieName('state', scheme, secureCookie, 'oidc'),
    sessionCookieTtlSeconds: input.sessionCookieTtlSeconds ?? 3600,
    roleClaimType: input.roleClaimType ?? 'roles',
    allowPlainPKCE: input.allowPlainPKCE ?? false,
    clockToleranceSeconds: input.clockToleranceSeconds ?? 60,
    httpTimeoutMs: input.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    discoveryCacheTtlSeconds: input.discoveryCacheTtlSeconds ?? 3600,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'auto',
    showPii: input.showPii ?? false,
    challengeMode: input.challengeMode ?? 'auto',
    getClaimsFromUserInfoEndpoint: input.getClaimsFromUserInfoEndpoint ?? false,
    saveTokens: input.saveTokens ?? false,
  }
}

export class OIDCAuthenticationOptionsBuilder {
  readonly #options: Partial<OIDCAuthenticationOptions> = {}

  clientID(id: string): this {
    this.#options.clientID = id
    return this
  }

  clientSecret(secret: string): this {
    this.#options.clientSecret = secret
    return this
  }

  discoveryURL(url: string): this {
    this.#options.discoveryURL = url
    return this
  }

  authorizationEndpoint(url: string): this {
    this.#options.authorizationEndpoint = url
    return this
  }

  tokenEndpoint(url: string): this {
    this.#options.tokenEndpoint = url
    return this
  }

  jwksURI(uri: string): this {
    this.#options.jwksURI = uri
    return this
  }

  issuer(issuer: string): this {
    this.#options.issuer = issuer
    return this
  }

  callbackURL(url: string): this {
    this.#options.callbackURL = url
    return this
  }

  defaultRedirectPath(path: string): this {
    this.#options.defaultRedirectPath = path
    return this
  }

  scopes(...scopes: string[]): this {
    this.#options.scopes = scopes
    return this
  }

  sessionSecret(secret: string): this {
    this.#options.sessionSecret = secret
    return this
  }

  sessionCookieName(name: string): this {
    this.#options.sessionCookieName = name
    return this
  }

  sessionCookieTtlSeconds(seconds: number): this {
    this.#options.sessionCookieTtlSeconds = seconds
    return this
  }

  stateCookieName(name: string): this {
    this.#options.stateCookieName = name
    return this
  }

  /**
   * Sends the session and state cookies only over HTTPS.
   *
   * Defaults to whether `callbackURL` is an `https:` URL, so production is secure by
   * default while local `http://localhost` development still works. Set explicitly to
   * override.
   */
  secureCookie(secure: boolean): this {
    this.#options.secureCookie = secure
    return this
  }

  /** Claim type carrying the user's roles. Providers differ: `groups` on Okta and Keycloak. */
  roleClaimType(type: string): this {
    this.#options.roleClaimType = type
    return this
  }

  /**
   * Permits the `plain` PKCE method. Off by default: RFC 7636 §4.4.2 and the OAuth 2.0
   * Security BCP require S256, and `plain` offers no protection against code interception.
   */
  allowPlainPKCE(allow: boolean): this {
    this.#options.allowPlainPKCE = allow
    return this
  }

  clockToleranceSeconds(seconds: number): this {
    this.#options.clockToleranceSeconds = seconds
    return this
  }

  httpTimeoutMs(ms: number): this {
    this.#options.httpTimeoutMs = ms
    return this
  }

  /**
   * How long a fetched discovery document stays authoritative, in seconds. `0` refetches on
   * every use. Defaults to one hour.
   */
  discoveryCacheTtlSeconds(seconds: number): this {
    this.#options.discoveryCacheTtlSeconds = seconds
    return this
  }

  /**
   * How to authenticate to the token endpoint.
   *
   * Defaults to `auto`, which negotiates from the discovery document and prefers
   * `client_secret_basic` per RFC 6749 §2.3.1.
   */
  tokenEndpointAuthMethod(method: TokenEndpointAuthMethod | 'auto'): this {
    this.#options.tokenEndpointAuthMethod = method
    return this
  }

  onTokenValidated(cb: OIDCAuthenticationOptions['onTokenValidated']): this {
    this.#options.onTokenValidated = cb
    return this
  }

  onFail(cb: OIDCAuthenticationOptions['onFail']): this {
    this.#options.onFail = cb
    return this
  }

  onChallenge(cb: OIDCAuthenticationOptions['onChallenge']): this {
    this.#options.onChallenge = cb
    return this
  }

  onForbid(cb: OIDCAuthenticationOptions['onForbid']): this {
    this.#options.onForbid = cb
    return this
  }

  claimMapper(mapper: OIDCAuthenticationOptions['claimMapper']): this {
    this.#options.claimMapper = mapper
    return this
  }

  /**
   * Drops the named claim types after mapping.
   *
   * Useful when a broader scope is needed at login but the fields should not be persisted,
   * e.g. requesting `profile` for a display name while dropping `picture` and `birthdate`.
   */
  removeClaims(...types: string[]): this {
    this.#options.claimActions = {
      ...this.#options.claimActions,
      remove: [...(this.#options.claimActions?.remove ?? []), ...types],
    }
    return this
  }

  /**
   * Reveals PII in server-side diagnostics, scoped to this strategy. Never enable in production.
   */
  showPii(show: boolean): this {
    this.#options.showPii = show
    return this
  }

  /** How an unauthenticated request is challenged. See {@link RemoteChallengeMode}. */
  challengeMode(mode: RemoteChallengeMode): this {
    this.#options.challengeMode = mode
    return this
  }

  /** The path of the route that starts a sign-in. `<callback path>/login` unless set. */
  loginPath(path: string): this {
    this.#options.loginPath = path
    return this
  }

  /**
   * Supplements the id_token with a UserInfo call. The id_token stays authoritative on any overlap.
   */
  getClaimsFromUserInfoEndpoint(get = true): this {
    this.#options.getClaimsFromUserInfoEndpoint = get
    return this
  }

  /** Overrides the endpoint discovery advertises. Rarely needed. */
  userInfoEndpoint(url: string): this {
    this.#options.userInfoEndpoint = url
    return this
  }

  /**
   * Keeps the provider's tokens on the server-side ticket.
   *
   * Requires a `ticketStore`; configuring without one is an error rather than a silent
   * downgrade. Needed for `signOut()`.
   */
  saveTokens(save = true): this {
    this.#options.saveTokens = save
    return this
  }

  /** Where the provider returns the user after ending its session. Must be registered there. */
  postLogoutRedirectURI(url: string): this {
    this.#options.postLogoutRedirectURI = url
    return this
  }

  /** Overrides the `end_session_endpoint` discovery advertises. */
  endSessionEndpoint(url: string): this {
    this.#options.endSessionEndpoint = url
    return this
  }

  /** OIDC Core §3.1.2.1 `prompt`. */
  prompt(prompt: NonNullable<OIDCAuthenticationOptions['prompt']>): this {
    this.#options.prompt = prompt
    return this
  }

  /** A hint at the account to use — usually an email from a preceding screen. */
  loginHint(hint: string): this {
    this.#options.loginHint = hint
    return this
  }

  /** Requested authentication context class references, most preferred first. */
  acrValues(...values: string[]): this {
    this.#options.acrValues = values
    return this
  }

  /**
   * Caps how old the provider-side authentication may be.
   *
   * The handler then requires `auth_time` in the id_token and rejects a stale one — asking
   * for freshness without checking it would be a control in name only.
   */
  maxAgeSeconds(seconds: number): this {
    this.#options.maxAgeSeconds = seconds
    return this
  }

  /** Provider-specific extras. Cannot override the protocol parameters. */
  extraAuthorizationParams(params: Record<string, string>): this {
    this.#options.extraAuthorizationParams = {
      ...this.#options.extraAuthorizationParams,
      ...params,
    }
    return this
  }

  /** Adjusts the authorization URL before the redirect. Protocol parameters are re-asserted after. */
  onRedirectToProvider(cb: OIDCAuthenticationOptions['onRedirectToProvider']): this {
    this.#options.onRedirectToProvider = cb
    return this
  }

  /**
   * Keeps sessions server-side so they can be revoked before their TTL expires.
   *
   * Without one the cookie is the session and signing out only clears the responding
   * browser's copy. No production store ships — supply one backed by shared infrastructure
   * such as Redis; `TestOIDCTicketStore` in `@caffeinejs/testing` covers tests.
   */
  ticketStore(store: RemoteAuthenticationTicketStore): this {
    this.#options.ticketStore = store
    return this
  }

  jwksResolver(resolver: OIDCAuthenticationOptions['jwksResolver']): this {
    this.#options.jwksResolver = resolver
    return this
  }

  /**
   * @param scheme - The strategy name, which namespaces the default cookie names and the
   * per-purpose key derivation. Required: without it two strategies share both.
   */
  build(scheme: string): ResolvedOIDCAuthenticationOptions {
    return resolveOIDCOptions(this.#options as OIDCAuthenticationOptions, scheme)
  }
}
