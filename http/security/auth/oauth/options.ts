import type { Context } from '../../../context.js'
import type { Claim } from '../../index.js'
import type { TokenEndpointAuthMethod } from '../internal/remote/client_auth.js'
import {
  assertSecureEndpoint,
  cookieName,
  DEFAULT_HTTP_TIMEOUT_MS,
  defaultSecureCookie,
  isSafeReturnPath,
  MIN_SESSION_SECRET_LENGTH,
} from '../internal/remote/config.js'
import { ErrOAuthConfiguration } from '../internal/remote/errors.js'
import type { RemoteAuthenticationTokens, RemoteChallengeMode } from '../internal/remote/handler.js'
import type { RemoteAuthenticationTicketStore } from '../internal/remote/ticket_store.js'

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

type DefaultedKey =
  | 'defaultRedirectPath'
  | 'scopes'
  | 'sessionCookieName'
  | 'stateCookieName'
  | 'sessionCookieTtlSeconds'
  | 'secureCookie'
  | 'roleClaimType'
  | 'httpTimeoutMs'
  | 'showPii'
  | 'challengeMode'
  | 'usePKCE'
  | 'subjectClaim'
  | 'tokenEndpointAuthMethod'

/**
 * A plain OAuth 2.0 strategy, for providers that do not implement OpenID Connect.
 *
 * GitHub, Discord, Slack and X all fall here: no discovery document, no `id_token`, no JWKS.
 * Identity comes from an authenticated call to the provider's user information endpoint — the
 * way even a provider like Google, which does offer OIDC, is commonly integrated. Prefer the
 * OIDC strategy whenever a provider supports it: a signed id_token is a stronger assertion than
 * a JSON body fetched with a bearer token.
 */
export interface ResolvedOAuth2AuthenticationOptions {
  clientID: string
  clientSecret: string

  authorizationEndpoint: string
  tokenEndpoint: string
  userInfoEndpoint: string

  callbackURL: string
  defaultRedirectPath: string
  scopes: string[]

  sessionSecret: string
  sessionCookieName: string
  sessionCookieTtlSeconds: number
  stateCookieName: string
  secureCookie: boolean

  roleClaimType: string
  httpTimeoutMs: number
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
   * Sends PKCE on the authorization request. On by default, S256 only.
   *
   * Turn it off only for a provider that rejects the parameters outright. Without PKCE the
   * flow leans entirely on the client secret and the state cookie.
   */
  usePKCE: boolean

  /**
   * Which user info field holds the stable user identifier.
   *
   * Must be a field that cannot be changed by the user: GitHub's `login` is renameable and
   * therefore unsuitable, while its numeric `id` is stable.
   */
  subjectClaim: string

  /**
   * How the client authenticates to the token endpoint. `client_secret_post` by default.
   *
   * Set `client_secret_basic` for a provider that accepts it: RFC 6749 §2.3.1 recommends against sending the
   * secret in the request body. With no discovery document, nothing here can tell which one a provider takes.
   */
  tokenEndpointAuthMethod: TokenEndpointAuthMethod

  /** Extra headers on the token request. Some providers require `Accept: application/json`. */
  tokenRequestHeaders?: Record<string, string>
  /** Extra headers on the user info request. Some providers require a `User-Agent`. */
  userInfoHeaders?: Record<string, string>

  /**
   * Claim shaping.
   *
   * `map` renames a user info field to a claim type — `{ sub: 'id', name: 'login' }` reads the
   * provider's `id` into a `sub` claim. `remove` drops claim types after mapping.
   */
  claimActions?: { map?: Record<string, string>; remove?: string[] }

  /**
   * Fetches anything the user info endpoint does not return.
   *
   * GitHub, for instance, omits the email unless it is public; this is where the extra
   * `/user/emails` call belongs. Runs with the access token, before claims are mapped.
   */
  enrichUserInfo?: (
    userInfo: Record<string, unknown>,
    tokens: RemoteAuthenticationTokens,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>

  ticketStore?: RemoteAuthenticationTicketStore
  onTokenValidated?: (
    ctx: Context,
    userInfo: Record<string, unknown>,
    tokens: RemoteAuthenticationTokens,
  ) => Promise<void> | void
  /**
   * Called when a session cookie is refused and when a callback fails, with the diagnostic error.
   *
   * On a failed callback it may answer the request — `ctx.redirect('/sign-in?failed=1')` — and what it answered is
   * what goes out. Left unanswered, the callback responds `400` with a generic body.
   */
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  /**
   * Shapes the challenge response, and receives where the browser should go next.
   *
   * A navigation receives the authorization URL, with state, PKCE and the state cookie already in place, so
   * the flow stays correct no matter what the hook does. Anything else receives this origin's
   * {@link loginPath} and starts no authorization round trip: a script cannot follow a redirect to the
   * provider, and the flow begins when a browser goes to the login path. Use it to answer `401` with that
   * URL in a shape of your own.
   */
  onChallenge?: (ctx: Context, redirectTo: string) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
  /** Full override of claim construction. `claimActions.remove` still applies afterwards. */
  claimMapper?: (userInfo: Record<string, unknown>) => Claim[]
}

export type OAuth2AuthenticationOptions = PartialBy<ResolvedOAuth2AuthenticationOptions, DefaultedKey>

export function resolveOAuth2Options(
  input: OAuth2AuthenticationOptions,
  scheme: string,
): ResolvedOAuth2AuthenticationOptions {
  const required: Array<[string, string | undefined]> = [
    ['clientID', input.clientID],
    ['clientSecret', input.clientSecret],
    ['sessionSecret', input.sessionSecret],
    ['callbackURL', input.callbackURL],
    ['authorizationEndpoint', input.authorizationEndpoint],
    ['tokenEndpoint', input.tokenEndpoint],
    ['userInfoEndpoint', input.userInfoEndpoint],
  ]
  for (const [label, value] of required) {
    if (!value) {
      throw new ErrOAuthConfiguration(`Cannot configure OAuth2: ${label} is required`)
    }
  }

  if (input.sessionSecret!.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ErrOAuthConfiguration(
      `Cannot configure OAuth2: sessionSecret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    )
  }

  // The callback carries the authorization code and the endpoints carry the token and the
  // access token; over plain http every one of them is interceptable.
  for (const label of ['callbackURL', 'authorizationEndpoint', 'tokenEndpoint', 'userInfoEndpoint'] as const) {
    assertSecureEndpoint(label, input[label]!)
  }

  const defaultRedirectPath = input.defaultRedirectPath ?? '/'
  if (!isSafeReturnPath(defaultRedirectPath)) {
    throw new ErrOAuthConfiguration(
      `Cannot configure OAuth2: defaultRedirectPath "${defaultRedirectPath}" must be a same-site absolute path`,
    )
  }

  const secureCookie = input.secureCookie ?? defaultSecureCookie(input.callbackURL!)
  const roleClaimType = input.roleClaimType ?? 'roles'
  const subjectClaim = input.subjectClaim ?? 'id'

  // The claim mapping is an allowlist (see `defaultMapClaims`), so an unconfigured strategy would produce
  // a principal with no claims at all — authenticated, but invisible to every policy that looks for `sub`.
  // Seeding the subject keeps the zero-config path working without reopening the door: the mapping is
  // chosen here from `subjectClaim`, never named by the provider.
  const claimActions =
    input.claimMapper === undefined
      ? { ...input.claimActions, map: { sub: subjectClaim, ...input.claimActions?.map } }
      : input.claimActions

  // Mapping the provider's own field into the role claim is how a user-controlled profile value becomes a
  // role. It may still be done deliberately — an `enrichUserInfo` that resolves org membership server-side
  // is the legitimate case — but it must be written down as a claimMapper rather than fall out of a rename.
  const mappedRole = claimActions?.map?.[roleClaimType]
  if (mappedRole !== undefined && input.claimMapper === undefined) {
    throw new ErrOAuthConfiguration(
      `Cannot configure OAuth2: claimActions.map sends the user info field "${mappedRole}" into the role ` +
        `claim "${roleClaimType}", which lets the provider choose the caller's roles — use a claimMapper ` +
        'if that is intended',
    )
  }

  return {
    ...input,
    roleClaimType,
    subjectClaim,
    claimActions,
    clientID: input.clientID!,
    clientSecret: input.clientSecret!,
    sessionSecret: input.sessionSecret!,
    callbackURL: input.callbackURL!,
    authorizationEndpoint: input.authorizationEndpoint!,
    tokenEndpoint: input.tokenEndpoint!,
    userInfoEndpoint: input.userInfoEndpoint!,
    defaultRedirectPath,
    scopes: input.scopes ?? [],
    secureCookie,
    sessionCookieName: input.sessionCookieName ?? cookieName('session', scheme, secureCookie, 'oauth2'),
    stateCookieName: input.stateCookieName ?? cookieName('state', scheme, secureCookie, 'oauth2'),
    sessionCookieTtlSeconds: input.sessionCookieTtlSeconds ?? 3600,
    httpTimeoutMs: input.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    showPii: input.showPii ?? false,
    challengeMode: input.challengeMode ?? 'auto',
    usePKCE: input.usePKCE ?? true,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'client_secret_post',
  }
}

export class OAuth2AuthenticationOptionsBuilder {
  readonly #options: Partial<OAuth2AuthenticationOptions> = {}

  clientID(id: string): this {
    this.#options.clientID = id
    return this
  }

  clientSecret(secret: string): this {
    this.#options.clientSecret = secret
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

  userInfoEndpoint(url: string): this {
    this.#options.userInfoEndpoint = url
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

  stateCookieName(name: string): this {
    this.#options.stateCookieName = name
    return this
  }

  sessionCookieTtlSeconds(seconds: number): this {
    this.#options.sessionCookieTtlSeconds = seconds
    return this
  }

  secureCookie(secure: boolean): this {
    this.#options.secureCookie = secure
    return this
  }

  roleClaimType(type: string): this {
    this.#options.roleClaimType = type
    return this
  }

  httpTimeoutMs(ms: number): this {
    this.#options.httpTimeoutMs = ms
    return this
  }

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

  /** Off only for a provider that rejects the PKCE parameters outright. */
  usePKCE(use: boolean): this {
    this.#options.usePKCE = use
    return this
  }

  /** Which user info field is the stable identifier. Must not be user-renameable. */
  subjectClaim(field: string): this {
    this.#options.subjectClaim = field
    return this
  }

  /** How the client authenticates to the token endpoint. `client_secret_basic` for a provider that accepts it. */
  tokenEndpointAuthMethod(method: TokenEndpointAuthMethod): this {
    this.#options.tokenEndpointAuthMethod = method
    return this
  }

  tokenRequestHeaders(headers: Record<string, string>): this {
    this.#options.tokenRequestHeaders = { ...this.#options.tokenRequestHeaders, ...headers }
    return this
  }

  userInfoHeaders(headers: Record<string, string>): this {
    this.#options.userInfoHeaders = { ...this.#options.userInfoHeaders, ...headers }
    return this
  }

  /** Renames user info fields to claim types. */
  mapClaims(map: Record<string, string>): this {
    this.#options.claimActions = {
      ...this.#options.claimActions,
      map: { ...this.#options.claimActions?.map, ...map },
    }
    return this
  }

  /** Drops claim types after mapping. */
  removeClaims(...types: string[]): this {
    this.#options.claimActions = {
      ...this.#options.claimActions,
      remove: [...(this.#options.claimActions?.remove ?? []), ...types],
    }
    return this
  }

  enrichUserInfo(fn: OAuth2AuthenticationOptions['enrichUserInfo']): this {
    this.#options.enrichUserInfo = fn
    return this
  }

  ticketStore(store: RemoteAuthenticationTicketStore): this {
    this.#options.ticketStore = store
    return this
  }

  onTokenValidated(cb: OAuth2AuthenticationOptions['onTokenValidated']): this {
    this.#options.onTokenValidated = cb
    return this
  }

  onFail(cb: OAuth2AuthenticationOptions['onFail']): this {
    this.#options.onFail = cb
    return this
  }

  onChallenge(cb: OAuth2AuthenticationOptions['onChallenge']): this {
    this.#options.onChallenge = cb
    return this
  }

  onForbid(cb: OAuth2AuthenticationOptions['onForbid']): this {
    this.#options.onForbid = cb
    return this
  }

  claimMapper(mapper: OAuth2AuthenticationOptions['claimMapper']): this {
    this.#options.claimMapper = mapper
    return this
  }

  build(scheme: string): ResolvedOAuth2AuthenticationOptions {
    return resolveOAuth2Options(this.#options as OAuth2AuthenticationOptions, scheme)
  }

  /**
   * The raw, unresolved options this builder has collected.
   *
   * For callers that must transform the options before resolution — a provider preset that
   * fills in endpoints and scopes. Resolving first would reject the very fields the preset
   * supplies, and would also fire the resolver's `scopes ?? []` default, leaving the preset's
   * own scope default dead. The handler constructor resolves exactly once, afterwards.
   */
  toOptions(): OAuth2AuthenticationOptions {
    return this.#options as OAuth2AuthenticationOptions
  }
}
