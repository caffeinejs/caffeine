import { $t } from '@caffeinejs/std'
import type { ConfigSchema } from '@caffeinejs/std/config'
import { validateSchema, type AnySchema } from '@caffeinejs/std/schema'

import type { BasicAuthenticationOptionsBuilder } from './basic/basic_options.js'
import type { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import { ErrAuthConfiguration } from './errors.js'
import type { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import type { OAuth2AuthenticationOptionsBuilder } from './oauth/index.js'
import type { OIDCAuthenticationOptionsBuilder } from './oidc/index.js'
import type { OpaqueTokenAuthenticationOptionsBuilder } from './opaque/opaque_options.js'
import type { RefreshTokenOptionsBuilder } from './refresh/refresh_options.js'

/** The scheme kinds an `addX(...)` call can register. Each has one entry in {@link SCHEME_CONFIG}. */
export type SchemeKind = 'jwt' | 'basic' | 'cookie' | 'opaque' | 'oidc' | 'oauth' | 'github'

/**
 * What an application may configure for authentication, handed to the builder with
 * `AuthenticationBuilder.config`.
 *
 * `schemes` is keyed by the name the `addX(...)` call gave the scheme, and each entry carries that kind's
 * configurable keys — {@link SCHEME_CONFIG} holds one schema per kind.
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
  schemes?: Record<string, Record<string, unknown>>
  credentials?: Record<string, unknown>
  refresh?: Record<string, unknown>
}

/** `credentials.*` — the identity stamped on a principal built from a username and password. */

export const credentialsConfigSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  roleClaimType: $t.Optional($t.String()),
})

/** `refresh.*` — the two token lifetimes. The resolver and the claim mapper are functions. */
const ttl = (): ReturnType<typeof $t.Union> => $t.Union([$t.String(), $t.Number()])

export const refreshConfigSchema = $t.Object({
  accessTtl: $t.Optional(ttl()),
  refreshTtl: $t.Optional(ttl()),
  absoluteTtl: $t.Optional(ttl()),
})

/**
 * The shape of the authentication block, with `schemes` left open.
 *
 * Open because the keys one scheme accepts depend on its kind, which only the `addX(...)` call knows. Each
 * scheme's block is still validated, against its kind's schema, when the scheme is built: a key the kind does not
 * have, or a value its option does not take, fails `ready()`.
 *
 * Declaring a scheme precisely moves that check to where the configuration loads, which is also what a reload
 * goes through:
 *
 * ```ts
 * $t.Object({ schemes: $t.Object({ Bearer: SCHEME_SCHEMAS.jwt }) })
 * ```
 */
export const authConfigSchema = $t.Object({
  defaultAuthenticateScheme: $t.Optional($t.String()),
  defaultChallengeScheme: $t.Optional($t.String()),
  defaultForbidScheme: $t.Optional($t.String()),
  schemes: $t.Optional($t.Record($t.String(), $t.Record($t.String(), $t.Unknown()))),
  credentials: $t.Optional(credentialsConfigSchema),
  refresh: $t.Optional(refreshConfigSchema),
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
 *
 * The values are validated against the kind's own schema first, which is also what converts them. The
 * application's schema may leave a scheme's keys open — the exported {@link authConfigSchema} does — and an
 * environment variable is text: `"false"` handed to a boolean option as it arrived would turn the option on.
 *
 * @param where - What is being configured, for the error: `authentication scheme "jwt"`.
 * @throws ErrAuthConfiguration for a key the kind does not have, or a value its option does not take. A misspelt
 * key that was dropped instead would leave the check the operator believed was on never running.
 */
export function applyScheme<B>(
  builder: B,
  spec: SchemeConfigSpec<B>,
  values: Record<string, unknown>,
  where: string,
): void {
  for (const [key, value] of Object.entries(validated(spec, values, where))) {
    if (value !== undefined) {
      spec.appliers[key]!(builder, value as never)
    }
  }
}

/** The configured values as the kind's schema types them. See {@link applyScheme}. */
export function validated<B>(
  spec: Pick<SchemeConfigSpec<B>, 'schema'> & { appliers?: SchemeAppliers<B> },
  values: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const known = Object.keys(spec.appliers ?? (spec.schema as { properties?: object }).properties ?? {})
  const present = Object.entries(values).filter(([, value]) => value !== undefined)

  const unknown = present.map(([key]) => key).filter(key => !known.includes(key))
  if (unknown.length > 0) {
    throw new ErrAuthConfiguration(
      `Cannot configure ${where}: ${unknown.map(key => `"${key}"`).join(', ')} is not an option of it ` +
        `(options: ${known.map(key => `"${key}"`).join(', ')})`,
    )
  }

  const result = validateSchema(spec.schema as AnySchema, Object.fromEntries(present), { decode: true })
  if (!result.ok) {
    throw new ErrAuthConfiguration(
      `Cannot configure ${where}: ${result.issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`,
    )
  }

  return result.value as Record<string, unknown>
}

const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

const jwtSchemeSchema = $t.Object({
  // Only the string form is configurable. A `KeyLike` or a `Uint8Array` cannot travel through a tree, so a
  // scheme built on one keeps supplying it in code.
  secret: $t.Optional($t.String()),
  issuer: $t.Optional($t.String()),
  audience: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
  algorithm: $t.Optional($t.String()),
  expiresIn: $t.Optional(ttl()),
  roleClaimType: $t.Optional($t.String()),
  includeErrorDetails: $t.Optional($t.Boolean()),
})

const jwt: SchemeConfigSpec<JWTAuthenticationOptionsBuilder> = {
  schema: jwtSchemeSchema,
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

const basicSchemeSchema = $t.Object({ realm: $t.Optional($t.String()) })

const basic: SchemeConfigSpec<BasicAuthenticationOptionsBuilder> = {
  schema: basicSchemeSchema,
  appliers: { realm: (b, v: string) => b.realm(v) },
}

const opaqueSchemeSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  realm: $t.Optional($t.String()),
})

const opaque: SchemeConfigSpec<OpaqueTokenAuthenticationOptionsBuilder> = {
  schema: opaqueSchemeSchema,
  appliers: {
    scheme: (b, v: string) => b.scheme(v),
    realm: (b, v: string) => b.realm(v),
  },
}

const cookieSchemeSchema = $t.Object({
  sessionSecret: $t.Optional($t.String()),
  cookieName: $t.Optional($t.String()),
  rememberMe: $t.Optional($t.Boolean()),
  rememberMeCookieName: $t.Optional($t.String()),
  rememberMeRotationGraceSeconds: $t.Optional($t.Number()),
  rememberMeAbsoluteMaxAge: $t.Optional($t.Number()),
  challengeMode: $t.Optional(challengeMode()),
  loginPath: $t.Optional($t.String()),
  accessDeniedPath: $t.Optional($t.String()),
  returnUrlParameter: $t.Optional($t.String()),
  maxAge: $t.Optional($t.Number()),
  rememberMeMaxAge: $t.Optional($t.Number()),
  secure: $t.Optional($t.Boolean()),
  sameSite: $t.Optional($t.UnionEnum(['strict', 'lax', 'none'])),
  path: $t.Optional($t.String()),
  roleClaimType: $t.Optional($t.String()),
})

const cookie: SchemeConfigSpec<CookieAuthenticationOptionsBuilder> = {
  schema: cookieSchemeSchema,
  appliers: {
    sessionSecret: (b, v: string) => b.sessionSecret(v),
    cookieName: (b, v: string) => b.cookieName(v),
    rememberMe: (b, v: boolean) => b.rememberMe(v),
    rememberMeCookieName: (b, v: string) => b.rememberMeCookieName(v),
    rememberMeRotationGraceSeconds: (b, v: number) => b.rememberMeRotationGraceSeconds(v),
    rememberMeAbsoluteMaxAge: (b, v: number) => b.rememberMeAbsoluteMaxAge(v),
    challengeMode: (b, v: 'auto' | 'redirect' | 'status') => b.challengeMode(v),
    loginPath: (b, v: string) => b.loginPath(v),
    accessDeniedPath: (b, v: string) => b.accessDeniedPath(v),
    returnUrlParameter: (b, v: string) => b.returnURLParameter(v),
    maxAge: (b, v: number) => b.maxAge(v),
    rememberMeMaxAge: (b, v: number) => b.rememberMeMaxAge(v),
    secure: (b, v: boolean) => b.secure(v),
    sameSite: (b, v: 'strict' | 'lax' | 'none') => b.sameSite(v),
    path: (b, v: string) => b.path(v),
    roleClaimType: (b, v: string) => b.roleClaimType(v),
  },
}

const oidcSchemeSchema = $t.Object({
  clientId: $t.Optional($t.String()),
  clientSecret: $t.Optional($t.String()),
  sessionSecret: $t.Optional($t.String()),
  discoveryUrl: $t.Optional($t.String()),
  issuer: $t.Optional($t.String()),
  authorizationEndpoint: $t.Optional($t.String()),
  tokenEndpoint: $t.Optional($t.String()),
  userInfoEndpoint: $t.Optional($t.String()),
  jwksUri: $t.Optional($t.String()),
  callbackUrl: $t.Optional($t.String()),
  defaultRedirectPath: $t.Optional($t.String()),
  scopes: $t.Optional($t.Array($t.String())),
  sessionCookieName: $t.Optional($t.String()),
  sessionCookieTtlSeconds: $t.Optional($t.Number()),
  stateCookieName: $t.Optional($t.String()),
  secureCookie: $t.Optional($t.Boolean()),
  roleClaimType: $t.Optional($t.String()),
  allowPlainPkce: $t.Optional($t.Boolean()),
  clockToleranceSeconds: $t.Optional($t.Number()),
  httpTimeoutMs: $t.Optional($t.Number()),
  discoveryCacheTtlSeconds: $t.Optional($t.Number()),
  tokenEndpointAuthMethod: $t.Optional($t.UnionEnum(['auto', 'client_secret_basic', 'client_secret_post'])),
  showPii: $t.Optional($t.Boolean()),
  challengeMode: $t.Optional(challengeMode()),
  loginPath: $t.Optional($t.String()),
  getClaimsFromUserInfoEndpoint: $t.Optional($t.Boolean()),
  saveTokens: $t.Optional($t.Boolean()),
  postLogoutRedirectUri: $t.Optional($t.String()),
  endSessionEndpoint: $t.Optional($t.String()),
  prompt: $t.Optional($t.UnionEnum(['none', 'login', 'consent', 'select_account'])),
  loginHint: $t.Optional($t.String()),
  acrValues: $t.Optional($t.Array($t.String())),
  maxAgeSeconds: $t.Optional($t.Number()),
  extraAuthorizationParams: $t.Optional($t.Record($t.String(), $t.String())),
})

const oidc: SchemeConfigSpec<OIDCAuthenticationOptionsBuilder> = {
  schema: oidcSchemeSchema,
  appliers: {
    clientId: (b, v: string) => b.clientID(v),
    clientSecret: (b, v: string) => b.clientSecret(v),
    sessionSecret: (b, v: string) => b.sessionSecret(v),
    discoveryUrl: (b, v: string) => b.discoveryURL(v),
    issuer: (b, v: string) => b.issuer(v),
    authorizationEndpoint: (b, v: string) => b.authorizationEndpoint(v),
    tokenEndpoint: (b, v: string) => b.tokenEndpoint(v),
    userInfoEndpoint: (b, v: string) => b.userInfoEndpoint(v),
    jwksUri: (b, v: string) => b.jwksURI(v),
    callbackUrl: (b, v: string) => b.callbackURL(v),
    defaultRedirectPath: (b, v: string) => b.defaultRedirectPath(v),
    scopes: (b, v: string[]) => b.scopes(...v),
    sessionCookieName: (b, v: string) => b.sessionCookieName(v),
    sessionCookieTtlSeconds: (b, v: number) => b.sessionCookieTtlSeconds(v),
    stateCookieName: (b, v: string) => b.stateCookieName(v),
    secureCookie: (b, v: boolean) => b.secureCookie(v),
    roleClaimType: (b, v: string) => b.roleClaimType(v),
    allowPlainPkce: (b, v: boolean) => b.allowPlainPKCE(v),
    clockToleranceSeconds: (b, v: number) => b.clockToleranceSeconds(v),
    httpTimeoutMs: (b, v: number) => b.httpTimeoutMs(v),
    discoveryCacheTtlSeconds: (b, v: number) => b.discoveryCacheTtlSeconds(v),
    tokenEndpointAuthMethod: (b, v: 'auto' | 'client_secret_basic' | 'client_secret_post') =>
      b.tokenEndpointAuthMethod(v),
    showPii: (b, v: boolean) => b.showPii(v),
    challengeMode: (b, v: 'auto' | 'redirect' | 'status') => b.challengeMode(v),
    loginPath: (b, v: string) => b.loginPath(v),
    getClaimsFromUserInfoEndpoint: (b, v: boolean) => b.getClaimsFromUserInfoEndpoint(v),
    saveTokens: (b, v: boolean) => b.saveTokens(v),
    postLogoutRedirectUri: (b, v: string) => b.postLogoutRedirectURI(v),
    endSessionEndpoint: (b, v: string) => b.endSessionEndpoint(v),
    prompt: (b, v: 'none' | 'login' | 'consent' | 'select_account') => b.prompt(v),
    loginHint: (b, v: string) => b.loginHint(v),
    acrValues: (b, v: string[]) => b.acrValues(...v),
    maxAgeSeconds: (b, v: number) => b.maxAgeSeconds(v),
    extraAuthorizationParams: (b, v: Record<string, string>) => b.extraAuthorizationParams(v),
  },
}

const oauthSchemeSchema = $t.Object({
  clientId: $t.Optional($t.String()),
  clientSecret: $t.Optional($t.String()),
  sessionSecret: $t.Optional($t.String()),
  authorizationEndpoint: $t.Optional($t.String()),
  tokenEndpoint: $t.Optional($t.String()),
  userInfoEndpoint: $t.Optional($t.String()),
  callbackUrl: $t.Optional($t.String()),
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
  loginPath: $t.Optional($t.String()),
  usePkce: $t.Optional($t.Boolean()),
  subjectClaim: $t.Optional($t.String()),
  tokenEndpointAuthMethod: $t.Optional($t.UnionEnum(['client_secret_basic', 'client_secret_post'])),
  tokenRequestHeaders: $t.Optional($t.Record($t.String(), $t.String())),
  userInfoHeaders: $t.Optional($t.Record($t.String(), $t.String())),
  mapClaims: $t.Optional($t.Record($t.String(), $t.String())),
})

const oauth: SchemeConfigSpec<OAuth2AuthenticationOptionsBuilder> = {
  schema: oauthSchemeSchema,
  appliers: {
    clientId: (b, v: string) => b.clientID(v),
    clientSecret: (b, v: string) => b.clientSecret(v),
    sessionSecret: (b, v: string) => b.sessionSecret(v),
    authorizationEndpoint: (b, v: string) => b.authorizationEndpoint(v),
    tokenEndpoint: (b, v: string) => b.tokenEndpoint(v),
    userInfoEndpoint: (b, v: string) => b.userInfoEndpoint(v),
    callbackUrl: (b, v: string) => b.callbackURL(v),
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
    loginPath: (b, v: string) => b.loginPath(v),
    usePkce: (b, v: boolean) => b.usePKCE(v),
    subjectClaim: (b, v: string) => b.subjectClaim(v),
    tokenEndpointAuthMethod: (b, v: 'client_secret_basic' | 'client_secret_post') => b.tokenEndpointAuthMethod(v),
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
/**
 * Each scheme kind's configurable shape, for an application that declares its schemes precisely.
 *
 * Splice one in where the block lives — `$t.Object({ Bearer: SCHEME_SCHEMAS.jwt })` — to have a scheme's
 * options validated.
 */
export const SCHEME_SCHEMAS = {
  jwt: jwtSchemeSchema,
  basic: basicSchemeSchema,
  cookie: cookieSchemeSchema,
  opaque: opaqueSchemeSchema,
  oidc: oidcSchemeSchema,
  oauth: oauthSchemeSchema,
  github: oauthSchemeSchema,
} as const

export const SCHEME_CONFIG = {
  jwt,
  basic,
  cookie,
  opaque,
  oidc,
  oauth,
  github: oauth,
} satisfies { readonly [K in SchemeKind]: SchemeConfigSpec<never> }

export const refresh: SchemeConfigSpec<RefreshTokenOptionsBuilder> = {
  schema: refreshConfigSchema as ConfigSchema<Record<string, unknown>>,
  appliers: {
    accessTtl: (b, v: string | number) => b.accessTTL(v),
    refreshTtl: (b, v: string | number) => b.refreshTTL(v),
    absoluteTtl: (b, v: string | number) => b.absoluteTTL(v),
  },
}
