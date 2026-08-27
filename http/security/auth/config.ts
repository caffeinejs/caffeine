import { $t } from '@caffeinejs/std'
import type { ConfigSchema } from '@caffeinejs/std/config'
import type { BasicAuthenticationOptionsBuilder } from './basic/basic_options.js'
import type { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import type { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import type { OpaqueTokenAuthenticationOptionsBuilder } from './opaque/opaque_options.js'
import type { OIDCAuthenticationOptionsBuilder } from './oidc/index.js'
import type { OAuth2AuthenticationOptionsBuilder } from './oauth/index.js'
import type { RefreshTokenOptionsBuilder } from './refresh/refresh_options.js'

/** The default location of the authentication settings in the configuration tree. */
export const AUTH_CONFIG_NAMESPACE: readonly string[] = ['auth']

/**
 * Where one scheme's settings live: `auth.schemes.<name>.*`, under the scheme's own registered name.
 *
 * **A scheme addressed by environment variable needs a lowercase name.** `EnvConfigProvider` lowercases each
 * path segment before folding underscores into camelCase, so `AUTH__SCHEMES__BEARER__SECRET` resolves to
 * `auth.schemes.bearer`, not `auth.schemes.Bearer`. The default names the `addX` methods choose are
 * capitalized (`Bearer`, `Basic`, `Cookie`, `OpaqueToken`), so name the scheme explicitly —
 * `addJWTBearer('jwt', ...)` — wherever an environment variable has to reach it. A file or an inline source
 * addresses a capitalized name as written.
 */
export function schemeNamespace(base: readonly string[], name: string): readonly string[] {
  return [...base, 'schemes', name]
}

/** The kinds of scheme that carry configurable options. `addStrategy` and `forward` take none. */
export type SchemeKind = 'jwt' | 'basic' | 'cookie' | 'opaque' | 'oidc' | 'oauth' | 'github'

/**
 * The scheme-independent half: which scheme answers when a route names none.
 *
 * Scheme *names* are configurable, but which schemes exist is not — a scheme is registered by an `addX` call,
 * so naming one here that no call created is rejected at start-up rather than silently ignored.
 */
export interface AuthConfigSlice {
  defaultAuthenticateScheme?: string
  defaultChallengeScheme?: string
  defaultForbidScheme?: string
}

export const authConfigSchema = $t.Object({
  defaultAuthenticateScheme: $t.Optional($t.String()),
  defaultChallengeScheme: $t.Optional($t.String()),
  defaultForbidScheme: $t.Optional($t.String()),
})

/** `auth.credentials.*` — the identity stamped on a principal built from a username and password. */
export const CREDENTIALS_CONFIG_SEGMENT = 'credentials'

export const credentialsConfigSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  roleClaimType: $t.Optional($t.String()),
})

/** `auth.refresh.*` — the two token lifetimes. The resolver and the claim mapper are functions. */
export const REFRESH_CONFIG_SEGMENT = 'refresh'

const ttl = (): ReturnType<typeof $t.Union> => $t.Union([$t.String(), $t.Number()])

export const refreshConfigSchema = $t.Object({
  accessTTL: $t.Optional(ttl()),
  refreshTTL: $t.Optional(ttl()),
})

/**
 * How one configured key is applied to an options builder.
 *
 * The builder's own setter is called rather than the built object being merged, because the setters carry
 * logic a merge would skip: `JWTAuthenticationOptionsBuilder.secret()` mirrors into both the verify options
 * and the sign service, and `issuer`/`audience` are deliberately *absent* rather than `undefined` so that
 * `JWTService.verify` can spread over its own defaults.
 */
type Applier<B> = (builder: B, value: never) => void

export type SchemeAppliers<B> = Record<string, Applier<B>>

/** A scheme kind's configurable surface: what the tree may carry, and how it reaches the builder. */
export interface SchemeConfigSpec<B> {
  schema: ConfigSchema<Record<string, unknown>>
  appliers: SchemeAppliers<B>
}

/**
 * Replays the configured values onto the builder, after the application's own callback has run.
 *
 * Order is what makes a builder call a *default*: the callback sets code values first, and whatever
 * configuration resolved is applied over them. A key the tree does not carry leaves the code value alone.
 */
export function applyScheme<B>(builder: B, spec: SchemeConfigSpec<B>, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue
    }

    spec.appliers[key]?.(builder, value as never)
  }
}

const secretString = (): ReturnType<typeof $t.Secret> => $t.Secret($t.String())

const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

const jwt: SchemeConfigSpec<JWTAuthenticationOptionsBuilder> = {
  schema: $t.Object({
    // Only the string form is configurable. A `KeyLike` or a `Uint8Array` cannot travel through a tree, so a
    // scheme built on one keeps supplying it in code.
    secret: $t.Optional(secretString()),
    issuer: $t.Optional($t.String()),
    audience: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
    algorithm: $t.Optional($t.String()),
    expiresIn: $t.Optional(ttl()),
    roleClaimType: $t.Optional($t.String()),
    includeErrorDetails: $t.Optional($t.Boolean()),
  }),
  appliers: {
    secret: (b, v: string) => b.secret(v),
    issuer: (b, v: string) => b.issuer(v),
    audience: (b, v: string | string[]) => b.audience(v),
    algorithm: (b, v: string) => b.algorithm(v),
    expiresIn: (b, v: string | number) => b.expiresIn(v),
    roleClaimType: (b, v: string) => b.roleClaimType(v),
    includeErrorDetails: (b, v: boolean) => b.includeErrorDetails(v),
  },
}

const basic: SchemeConfigSpec<BasicAuthenticationOptionsBuilder> = {
  schema: $t.Object({ realm: $t.Optional($t.String()) }),
  appliers: { realm: (b, v: string) => b.realm(v) },
}

const opaque: SchemeConfigSpec<OpaqueTokenAuthenticationOptionsBuilder> = {
  schema: $t.Object({
    scheme: $t.Optional($t.String()),
    realm: $t.Optional($t.String()),
  }),
  appliers: {
    scheme: (b, v: string) => b.scheme(v),
    realm: (b, v: string) => b.realm(v),
  },
}

const cookie: SchemeConfigSpec<CookieAuthenticationOptionsBuilder> = {
  schema: $t.Object({
    sessionSecret: $t.Optional(secretString()),
    cookieName: $t.Optional($t.String()),
    rememberMe: $t.Optional($t.Boolean()),
    rememberMeCookieName: $t.Optional($t.String()),
    rememberMeRotationGraceSeconds: $t.Optional($t.Number()),
    challengeMode: $t.Optional(challengeMode()),
    loginPath: $t.Optional($t.String()),
    accessDeniedPath: $t.Optional($t.String()),
    returnURLParameter: $t.Optional($t.String()),
    maxAge: $t.Optional($t.Number()),
    rememberMeMaxAge: $t.Optional($t.Number()),
    secure: $t.Optional($t.Boolean()),
    sameSite: $t.Optional($t.UnionEnum(['strict', 'lax', 'none'])),
    path: $t.Optional($t.String()),
    roleClaimType: $t.Optional($t.String()),
  }),
  appliers: {
    sessionSecret: (b, v: string) => b.sessionSecret(v),
    cookieName: (b, v: string) => b.cookieName(v),
    rememberMe: (b, v: boolean) => b.rememberMe(v),
    rememberMeCookieName: (b, v: string) => b.rememberMeCookieName(v),
    rememberMeRotationGraceSeconds: (b, v: number) => b.rememberMeRotationGraceSeconds(v),
    challengeMode: (b, v: 'auto' | 'redirect' | 'status') => b.challengeMode(v),
    loginPath: (b, v: string) => b.loginPath(v),
    accessDeniedPath: (b, v: string) => b.accessDeniedPath(v),
    returnURLParameter: (b, v: string) => b.returnURLParameter(v),
    maxAge: (b, v: number) => b.maxAge(v),
    rememberMeMaxAge: (b, v: number) => b.rememberMeMaxAge(v),
    secure: (b, v: boolean) => b.secure(v),
    sameSite: (b, v: 'strict' | 'lax' | 'none') => b.sameSite(v),
    path: (b, v: string) => b.path(v),
    roleClaimType: (b, v: string) => b.roleClaimType(v),
  },
}

const oidc: SchemeConfigSpec<OIDCAuthenticationOptionsBuilder> = {
  schema: $t.Object({
    clientID: $t.Optional($t.String()),
    clientSecret: $t.Optional(secretString()),
    sessionSecret: $t.Optional(secretString()),
    discoveryURL: $t.Optional($t.String()),
    issuer: $t.Optional($t.String()),
    authorizationEndpoint: $t.Optional($t.String()),
    tokenEndpoint: $t.Optional($t.String()),
    userInfoEndpoint: $t.Optional($t.String()),
    jwksURI: $t.Optional($t.String()),
    callbackURL: $t.Optional($t.String()),
    defaultRedirectPath: $t.Optional($t.String()),
    scopes: $t.Optional($t.Array($t.String())),
    sessionCookieName: $t.Optional($t.String()),
    sessionCookieTtlSeconds: $t.Optional($t.Number()),
    stateCookieName: $t.Optional($t.String()),
    secureCookie: $t.Optional($t.Boolean()),
    roleClaimType: $t.Optional($t.String()),
    allowPlainPKCE: $t.Optional($t.Boolean()),
    clockToleranceSeconds: $t.Optional($t.Number()),
    httpTimeoutMs: $t.Optional($t.Number()),
    discoveryCacheTtlSeconds: $t.Optional($t.Number()),
    tokenEndpointAuthMethod: $t.Optional($t.UnionEnum(['auto', 'client_secret_basic', 'client_secret_post'])),
    showPii: $t.Optional($t.Boolean()),
    challengeMode: $t.Optional(challengeMode()),
    getClaimsFromUserInfoEndpoint: $t.Optional($t.Boolean()),
    saveTokens: $t.Optional($t.Boolean()),
    postLogoutRedirectURI: $t.Optional($t.String()),
    endSessionEndpoint: $t.Optional($t.String()),
    prompt: $t.Optional($t.UnionEnum(['none', 'login', 'consent', 'select_account'])),
    loginHint: $t.Optional($t.String()),
    acrValues: $t.Optional($t.Array($t.String())),
    maxAgeSeconds: $t.Optional($t.Number()),
    extraAuthorizationParams: $t.Optional($t.Record($t.String(), $t.String())),
  }),
  appliers: {
    clientID: (b, v: string) => b.clientID(v),
    clientSecret: (b, v: string) => b.clientSecret(v),
    sessionSecret: (b, v: string) => b.sessionSecret(v),
    discoveryURL: (b, v: string) => b.discoveryURL(v),
    issuer: (b, v: string) => b.issuer(v),
    authorizationEndpoint: (b, v: string) => b.authorizationEndpoint(v),
    tokenEndpoint: (b, v: string) => b.tokenEndpoint(v),
    userInfoEndpoint: (b, v: string) => b.userInfoEndpoint(v),
    jwksURI: (b, v: string) => b.jwksURI(v),
    callbackURL: (b, v: string) => b.callbackURL(v),
    defaultRedirectPath: (b, v: string) => b.defaultRedirectPath(v),
    scopes: (b, v: string[]) => b.scopes(...v),
    sessionCookieName: (b, v: string) => b.sessionCookieName(v),
    sessionCookieTtlSeconds: (b, v: number) => b.sessionCookieTtlSeconds(v),
    stateCookieName: (b, v: string) => b.stateCookieName(v),
    secureCookie: (b, v: boolean) => b.secureCookie(v),
    roleClaimType: (b, v: string) => b.roleClaimType(v),
    allowPlainPKCE: (b, v: boolean) => b.allowPlainPKCE(v),
    clockToleranceSeconds: (b, v: number) => b.clockToleranceSeconds(v),
    httpTimeoutMs: (b, v: number) => b.httpTimeoutMs(v),
    discoveryCacheTtlSeconds: (b, v: number) => b.discoveryCacheTtlSeconds(v),
    tokenEndpointAuthMethod: (b, v: 'auto' | 'client_secret_basic' | 'client_secret_post') =>
      b.tokenEndpointAuthMethod(v),
    showPii: (b, v: boolean) => b.showPii(v),
    challengeMode: (b, v: 'auto' | 'redirect' | 'status') => b.challengeMode(v),
    getClaimsFromUserInfoEndpoint: (b, v: boolean) => b.getClaimsFromUserInfoEndpoint(v),
    saveTokens: (b, v: boolean) => b.saveTokens(v),
    postLogoutRedirectURI: (b, v: string) => b.postLogoutRedirectURI(v),
    endSessionEndpoint: (b, v: string) => b.endSessionEndpoint(v),
    prompt: (b, v: 'none' | 'login' | 'consent' | 'select_account') => b.prompt(v),
    loginHint: (b, v: string) => b.loginHint(v),
    acrValues: (b, v: string[]) => b.acrValues(...v),
    maxAgeSeconds: (b, v: number) => b.maxAgeSeconds(v),
    extraAuthorizationParams: (b, v: Record<string, string>) => b.extraAuthorizationParams(v),
  },
}

const oauth: SchemeConfigSpec<OAuth2AuthenticationOptionsBuilder> = {
  schema: $t.Object({
    clientID: $t.Optional($t.String()),
    clientSecret: $t.Optional(secretString()),
    sessionSecret: $t.Optional(secretString()),
    authorizationEndpoint: $t.Optional($t.String()),
    tokenEndpoint: $t.Optional($t.String()),
    userInfoEndpoint: $t.Optional($t.String()),
    callbackURL: $t.Optional($t.String()),
    defaultRedirectPath: $t.Optional($t.String()),
    scopes: $t.Optional($t.Array($t.String())),
    sessionCookieName: $t.Optional($t.String()),
    sessionCookieTtlSeconds: $t.Optional($t.Number()),
    stateCookieName: $t.Optional($t.String()),
    secureCookie: $t.Optional($t.Boolean()),
    roleClaimType: $t.Optional($t.String()),
    httpTimeoutMs: $t.Optional($t.Number()),
    showPii: $t.Optional($t.Boolean()),
    challengeMode: $t.Optional(challengeMode()),
    usePKCE: $t.Optional($t.Boolean()),
    subjectClaim: $t.Optional($t.String()),
    tokenRequestHeaders: $t.Optional($t.Record($t.String(), $t.String())),
    userInfoHeaders: $t.Optional($t.Record($t.String(), $t.String())),
    mapClaims: $t.Optional($t.Record($t.String(), $t.String())),
  }),
  appliers: {
    clientID: (b, v: string) => b.clientID(v),
    clientSecret: (b, v: string) => b.clientSecret(v),
    sessionSecret: (b, v: string) => b.sessionSecret(v),
    authorizationEndpoint: (b, v: string) => b.authorizationEndpoint(v),
    tokenEndpoint: (b, v: string) => b.tokenEndpoint(v),
    userInfoEndpoint: (b, v: string) => b.userInfoEndpoint(v),
    callbackURL: (b, v: string) => b.callbackURL(v),
    defaultRedirectPath: (b, v: string) => b.defaultRedirectPath(v),
    scopes: (b, v: string[]) => b.scopes(...v),
    sessionCookieName: (b, v: string) => b.sessionCookieName(v),
    sessionCookieTtlSeconds: (b, v: number) => b.sessionCookieTtlSeconds(v),
    stateCookieName: (b, v: string) => b.stateCookieName(v),
    secureCookie: (b, v: boolean) => b.secureCookie(v),
    roleClaimType: (b, v: string) => b.roleClaimType(v),
    httpTimeoutMs: (b, v: number) => b.httpTimeoutMs(v),
    showPii: (b, v: boolean) => b.showPii(v),
    challengeMode: (b, v: 'auto' | 'redirect' | 'status') => b.challengeMode(v),
    usePKCE: (b, v: boolean) => b.usePKCE(v),
    subjectClaim: (b, v: string) => b.subjectClaim(v),
    tokenRequestHeaders: (b, v: Record<string, string>) => b.tokenRequestHeaders(v),
    userInfoHeaders: (b, v: Record<string, string>) => b.userInfoHeaders(v),
    mapClaims: (b, v: Record<string, string>) => b.mapClaims(v),
  },
}

/**
 * Every scheme kind's configurable surface, keyed by the kind the `addX` call recorded.
 *
 * `github` shares OAuth 2.0's surface — the preset only supplies endpoint and scope defaults, and it is
 * applied to the same builder.
 */
export const SCHEME_CONFIG: { readonly [K in SchemeKind]: SchemeConfigSpec<never> } = {
  jwt: jwt as SchemeConfigSpec<never>,
  basic: basic as SchemeConfigSpec<never>,
  cookie: cookie as SchemeConfigSpec<never>,
  opaque: opaque as SchemeConfigSpec<never>,
  oidc: oidc as SchemeConfigSpec<never>,
  oauth: oauth as SchemeConfigSpec<never>,
  github: oauth as SchemeConfigSpec<never>,
}

export const refresh: SchemeConfigSpec<RefreshTokenOptionsBuilder> = {
  schema: refreshConfigSchema as ConfigSchema<Record<string, unknown>>,
  appliers: {
    accessTTL: (b, v: string | number) => b.accessTTL(v),
    refreshTTL: (b, v: string | number) => b.refreshTTL(v),
  },
}
