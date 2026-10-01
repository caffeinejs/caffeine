import type { BasicAuthenticationOptionsBuilder } from './basic/basic_options.js'
import type { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import type { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import type { OAuth2AuthenticationOptionsBuilder } from './oauth/index.js'
import type { OIDCAuthenticationOptionsBuilder } from './oidc/index.js'
import type { OpaqueTokenAuthenticationOptionsBuilder } from './opaque/opaque_options.js'
import type { RefreshTokenOptionsBuilder } from './refresh/refresh_options.js'

/** The scheme kinds an `addX(...)` call can register. Each has one entry in {@link SCHEME_CONFIG}. */
export type SchemeKind = 'jwt' | 'basic' | 'cookie' | 'opaque' | 'oidc' | 'oauth' | 'github'

type ChallengeMode = 'auto' | 'redirect' | 'status'

/** A JWT bearer scheme's configurable keys. Only the string form of `secret` travels a configuration tree. */
export interface JWTSchemeConfig {
  secret?: string
  issuer?: string
  audience?: string | readonly string[]
  algorithm?: string
  expiresIn?: string | number
  roleClaimType?: string
  includeErrorDetails?: boolean
}

/** A basic scheme's configurable keys. */
export interface BasicSchemeConfig {
  realm?: string
}

/** An opaque-token scheme's configurable keys. */
export interface OpaqueSchemeConfig {
  scheme?: string
  realm?: string
}

/** A cookie scheme's configurable keys. */
export interface CookieSchemeConfig {
  sessionSecret?: string
  cookieName?: string
  rememberMe?: boolean
  rememberMeCookieName?: string
  rememberMeRotationGraceSeconds?: number
  rememberMeAbsoluteMaxAge?: number
  challengeMode?: ChallengeMode
  loginPath?: string
  accessDeniedPath?: string
  returnUrlParameter?: string
  maxAge?: number
  rememberMeMaxAge?: number
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
  path?: string
  roleClaimType?: string
}

/** An OpenID Connect scheme's configurable keys. */
export interface OIDCSchemeConfig {
  clientId?: string
  clientSecret?: string
  sessionSecret?: string
  discoveryUrl?: string
  issuer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userInfoEndpoint?: string
  jwksUri?: string
  callbackUrl?: string
  defaultRedirectPath?: string
  scopes?: readonly string[]
  sessionCookieName?: string
  sessionCookieTtlSeconds?: number
  stateCookieName?: string
  secureCookie?: boolean
  roleClaimType?: string
  allowPlainPkce?: boolean
  clockToleranceSeconds?: number
  httpTimeoutMs?: number
  discoveryCacheTtlSeconds?: number
  tokenEndpointAuthMethod?: 'auto' | 'client_secret_basic' | 'client_secret_post'
  showPii?: boolean
  challengeMode?: ChallengeMode
  loginPath?: string
  getClaimsFromUserInfoEndpoint?: boolean
  saveTokens?: boolean
  postLogoutRedirectUri?: string
  endSessionEndpoint?: string
  prompt?: 'none' | 'login' | 'consent' | 'select_account'
  loginHint?: string
  acrValues?: readonly string[]
  maxAgeSeconds?: number
  extraAuthorizationParams?: Readonly<Record<string, string>>
}

/** An OAuth 2.0 scheme's configurable keys, GitHub's included. */
export interface OAuthSchemeConfig {
  clientId?: string
  clientSecret?: string
  sessionSecret?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userInfoEndpoint?: string
  callbackUrl?: string
  defaultRedirectPath?: string
  scopes?: readonly string[]
  sessionCookieName?: string
  sessionCookieTtlSeconds?: number
  stateCookieName?: string
  secureCookie?: boolean
  roleClaimType?: string
  httpTimeoutMs?: number
  showPii?: boolean
  challengeMode?: ChallengeMode
  loginPath?: string
  usePkce?: boolean
  subjectClaim?: string
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post'
  tokenRequestHeaders?: Readonly<Record<string, string>>
  userInfoHeaders?: Readonly<Record<string, string>>
  mapClaims?: Readonly<Record<string, string>>
}

/**
 * One scheme's block under `schemes`: every kind's keys, since the kind is known only to the `addX(...)` call.
 * Each scheme reads the keys of its own kind and ignores the rest.
 *
 * `tokenEndpointAuthMethod` takes OpenID Connect's values, `'auto'` included; an OAuth 2.0 scheme does not
 * accept `'auto'`.
 */
export type AuthSchemeConfig = JWTSchemeConfig &
  BasicSchemeConfig &
  OpaqueSchemeConfig &
  CookieSchemeConfig &
  Omit<OAuthSchemeConfig, 'tokenEndpointAuthMethod'> &
  OIDCSchemeConfig

/** `credentials.*`: the identity stamped on a principal built from a username and password. */
export interface AuthCredentialsConfig {
  scheme?: string
  roleClaimType?: string
}

/** `refresh.*`: the three token lifetimes. The resolver and the claim mapper are functions. */
export interface RefreshTokenConfig {
  accessTtl?: string | number
  refreshTtl?: string | number
  absoluteTtl?: string | number
}

/**
 * What an application may configure for authentication, handed to the builder with
 * `AuthenticationBuilder.config`.
 *
 * `schemes` is keyed by the name the `addX(...)` call gave the scheme.
 *
 * **A scheme addressed by environment variable needs a lowercase name.** `EnvConfigSource` lowercases each
 * path segment before folding underscores into camelCase, so `AUTH__SCHEMES__BEARER__SECRET` resolves to
 * `auth.schemes.bearer`, not `auth.schemes.Bearer`. The default names the `addX` methods choose are
 * capitalized (`Bearer`, `Basic`, `Cookie`, `OpaqueToken`), so name the scheme explicitly —
 * `addJWTBearer('jwt', ...)` — wherever an environment variable has to reach it. A file or an inline source
 * addresses a capitalized name as written.
 *
 * **Every key is spelled the way its environment variable folds**, so `CLIENT_ID` sets `clientId` and
 * `CALLBACK_URL` sets `callbackUrl`. That is not always the spelling of the builder method the key feeds:
 * `clientId` is what `clientID(...)` is called with.
 */
export interface AuthConfig {
  defaultAuthenticateScheme?: string
  defaultChallengeScheme?: string
  defaultForbidScheme?: string
  schemes?: Readonly<Record<string, AuthSchemeConfig>>
  credentials?: AuthCredentialsConfig
  refresh?: RefreshTokenConfig
}

/**
 * How each configurable key of `K` is applied to an options builder: one setter per key, so a key without one
 * does not compile.
 *
 * The builder's own setter is called rather than the built object being merged, because the setters carry
 * logic a merge would skip: `JWTAuthenticationOptionsBuilder.secret()` mirrors into both the verify options
 * and the sign service, and `issuer`/`audience` are deliberately *absent* rather than `undefined` so that
 * `JWTService.verify` can spread over its own defaults.
 */
export type SchemeAppliers<B, K> = { readonly [P in keyof K]-?: (builder: B, value: NonNullable<K[P]>) => void }

/**
 * Replays the configured values onto the builder, after the application's own callback has run.
 *
 * Order is what makes a builder call a *default*: the callback sets code values first, and whatever
 * configuration resolved is applied over them. A key the tree does not carry leaves the code value alone, and
 * a key another kind declares is not read.
 */
export function applyScheme<B, K extends object>(
  builder: B,
  appliers: SchemeAppliers<B, K>,
  values: K | undefined,
): void {
  if (values === undefined) {
    return
  }

  for (const key of Object.keys(appliers) as (keyof K)[]) {
    const value = values[key]

    if (value !== undefined) {
      appliers[key](builder, value as NonNullable<K[keyof K]>)
    }
  }
}

const jwt: SchemeAppliers<JWTAuthenticationOptionsBuilder, JWTSchemeConfig> = {
  secret: (b, v) => b.secret(v),
  issuer: (b, v) => b.issuer(v),
  audience: (b, v) => b.audience(typeof v === 'string' ? v : [...v]),
  algorithm: (b, v) => b.algorithm(v),
  expiresIn: (b, v) => b.expiresIn(v),
  roleClaimType: (b, v) => b.roleClaimType(v),
  includeErrorDetails: (b, v) => b.includeErrorDetails(v),
}

const basic: SchemeAppliers<BasicAuthenticationOptionsBuilder, BasicSchemeConfig> = {
  realm: (b, v) => b.realm(v),
}

const opaque: SchemeAppliers<OpaqueTokenAuthenticationOptionsBuilder, OpaqueSchemeConfig> = {
  scheme: (b, v) => b.scheme(v),
  realm: (b, v) => b.realm(v),
}

const cookie: SchemeAppliers<CookieAuthenticationOptionsBuilder, CookieSchemeConfig> = {
  sessionSecret: (b, v) => b.sessionSecret(v),
  cookieName: (b, v) => b.cookieName(v),
  rememberMe: (b, v) => b.rememberMe(v),
  rememberMeCookieName: (b, v) => b.rememberMeCookieName(v),
  rememberMeRotationGraceSeconds: (b, v) => b.rememberMeRotationGraceSeconds(v),
  rememberMeAbsoluteMaxAge: (b, v) => b.rememberMeAbsoluteMaxAge(v),
  challengeMode: (b, v) => b.challengeMode(v),
  loginPath: (b, v) => b.loginPath(v),
  accessDeniedPath: (b, v) => b.accessDeniedPath(v),
  returnUrlParameter: (b, v) => b.returnURLParameter(v),
  maxAge: (b, v) => b.maxAge(v),
  rememberMeMaxAge: (b, v) => b.rememberMeMaxAge(v),
  secure: (b, v) => b.secure(v),
  sameSite: (b, v) => b.sameSite(v),
  path: (b, v) => b.path(v),
  roleClaimType: (b, v) => b.roleClaimType(v),
}

const oidc: SchemeAppliers<OIDCAuthenticationOptionsBuilder, OIDCSchemeConfig> = {
  clientId: (b, v) => b.clientID(v),
  clientSecret: (b, v) => b.clientSecret(v),
  sessionSecret: (b, v) => b.sessionSecret(v),
  discoveryUrl: (b, v) => b.discoveryURL(v),
  issuer: (b, v) => b.issuer(v),
  authorizationEndpoint: (b, v) => b.authorizationEndpoint(v),
  tokenEndpoint: (b, v) => b.tokenEndpoint(v),
  userInfoEndpoint: (b, v) => b.userInfoEndpoint(v),
  jwksUri: (b, v) => b.jwksURI(v),
  callbackUrl: (b, v) => b.callbackURL(v),
  defaultRedirectPath: (b, v) => b.defaultRedirectPath(v),
  scopes: (b, v) => b.scopes(...v),
  sessionCookieName: (b, v) => b.sessionCookieName(v),
  sessionCookieTtlSeconds: (b, v) => b.sessionCookieTtlSeconds(v),
  stateCookieName: (b, v) => b.stateCookieName(v),
  secureCookie: (b, v) => b.secureCookie(v),
  roleClaimType: (b, v) => b.roleClaimType(v),
  allowPlainPkce: (b, v) => b.allowPlainPKCE(v),
  clockToleranceSeconds: (b, v) => b.clockToleranceSeconds(v),
  httpTimeoutMs: (b, v) => b.httpTimeoutMs(v),
  discoveryCacheTtlSeconds: (b, v) => b.discoveryCacheTtlSeconds(v),
  tokenEndpointAuthMethod: (b, v) => b.tokenEndpointAuthMethod(v),
  showPii: (b, v) => b.showPii(v),
  challengeMode: (b, v) => b.challengeMode(v),
  loginPath: (b, v) => b.loginPath(v),
  getClaimsFromUserInfoEndpoint: (b, v) => b.getClaimsFromUserInfoEndpoint(v),
  saveTokens: (b, v) => b.saveTokens(v),
  postLogoutRedirectUri: (b, v) => b.postLogoutRedirectURI(v),
  endSessionEndpoint: (b, v) => b.endSessionEndpoint(v),
  prompt: (b, v) => b.prompt(v),
  loginHint: (b, v) => b.loginHint(v),
  acrValues: (b, v) => b.acrValues(...v),
  maxAgeSeconds: (b, v) => b.maxAgeSeconds(v),
  extraAuthorizationParams: (b, v) => b.extraAuthorizationParams(v),
}

const oauth: SchemeAppliers<OAuth2AuthenticationOptionsBuilder, OAuthSchemeConfig> = {
  clientId: (b, v) => b.clientID(v),
  clientSecret: (b, v) => b.clientSecret(v),
  sessionSecret: (b, v) => b.sessionSecret(v),
  authorizationEndpoint: (b, v) => b.authorizationEndpoint(v),
  tokenEndpoint: (b, v) => b.tokenEndpoint(v),
  userInfoEndpoint: (b, v) => b.userInfoEndpoint(v),
  callbackUrl: (b, v) => b.callbackURL(v),
  defaultRedirectPath: (b, v) => b.defaultRedirectPath(v),
  scopes: (b, v) => b.scopes(...v),
  sessionCookieName: (b, v) => b.sessionCookieName(v),
  sessionCookieTtlSeconds: (b, v) => b.sessionCookieTtlSeconds(v),
  stateCookieName: (b, v) => b.stateCookieName(v),
  secureCookie: (b, v) => b.secureCookie(v),
  roleClaimType: (b, v) => b.roleClaimType(v),
  httpTimeoutMs: (b, v) => b.httpTimeoutMs(v),
  showPii: (b, v) => b.showPii(v),
  challengeMode: (b, v) => b.challengeMode(v),
  loginPath: (b, v) => b.loginPath(v),
  usePkce: (b, v) => b.usePKCE(v),
  subjectClaim: (b, v) => b.subjectClaim(v),
  tokenEndpointAuthMethod: (b, v) => b.tokenEndpointAuthMethod(v),
  tokenRequestHeaders: (b, v) => b.tokenRequestHeaders(v),
  userInfoHeaders: (b, v) => b.userInfoHeaders(v),
  mapClaims: (b, v) => b.mapClaims(v),
}

/**
 * Every scheme kind's appliers, keyed by the kind the `addX` call recorded.
 *
 * `github` shares OAuth 2.0's surface: the preset only supplies endpoint and scope defaults, and it is applied to
 * the same builder.
 */
export const SCHEME_CONFIG = {
  jwt,
  basic,
  cookie,
  opaque,
  oidc,
  oauth,
  github: oauth,
} as const

export const refresh: SchemeAppliers<RefreshTokenOptionsBuilder, RefreshTokenConfig> = {
  accessTtl: (b, v) => b.accessTTL(v),
  refreshTtl: (b, v) => b.refreshTTL(v),
  absoluteTtl: (b, v) => b.absoluteTTL(v),
}
