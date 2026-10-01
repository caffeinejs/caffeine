import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { CookieOptions } from './cookie/cookie.js'
import type { HealthConfig } from './health/options.js'
import type {
  AuthConfig,
  AuthCredentialsConfig,
  BasicSchemeConfig,
  CookieSchemeConfig,
  JWTSchemeConfig,
  OAuthSchemeConfig,
  OIDCSchemeConfig,
  OpaqueSchemeConfig,
  RefreshTokenConfig,
} from './security/auth/config.js'

/**
 * The schema of the health configuration block, satisfying {@link HealthConfig}. Hand the node to
 * `Health((h, { config }) => h.config(...))` and to `healthProbes(...)`.
 *
 * Every member is optional, and nothing is defaulted here: the resolved defaults are environment-dependent
 * (`isKubernetes`) and are applied once the builder resolves. So the tree carries only what somebody actually set,
 * and absence keeps its meaning instead of being overwritten by a default written into a low band.
 *
 * The budgets are `$t.Duration()`: `HEALTH__INDICATOR_TIMEOUT=5000` or `'5 hours'` fails validation at `bootstrap()`
 * rather than reaching a timer as 0.
 */
export const HealthConfigSchema = $t.Object({
  enabled: $t.Optional($t.Boolean()),
  paths: $t.Optional(
    $t.Object({
      live: $t.Optional($t.String()),
      ready: $t.Optional($t.String()),
      startup: $t.Optional($t.String()),
    }),
  ),
  indicatorTimeout: $t.Optional($t.Duration()),
  probeDeadline: $t.Optional($t.Duration()),
  cacheTtl: $t.Optional($t.Duration()),
  verbose: $t.Optional($t.Boolean()),
  exclude: $t.Optional($t.Boolean()),
})

type _HealthSatisfies = SchemaSatisfies<HealthConfig, InferConfig<typeof HealthConfigSchema>>

/**
 * The schema of the cookie configuration block, satisfying {@link CookieOptions}. Hand the node to
 * `.cookie((k, { config }) => k.config(...))`.
 *
 * `parseOptions` is not part of it: a serializer's `encode` is a function, which no configuration source can
 * carry, so those defaults are set with `parseOptions(...)`.
 */
export const CookieConfigSchema = $t.Object({
  enabled: $t.Boolean({ default: true }),
  secret: $t.Optional($t.String()),
})

type _CookieSatisfies = SchemaSatisfies<CookieOptions, InferConfig<typeof CookieConfigSchema>>

const ttl = (): ReturnType<typeof $t.Union> => $t.Union([$t.String(), $t.Number()])
const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

/** A JWT bearer scheme's block. Only the string form of `secret` is configurable. */
export const JWTSchemeConfigSchema = $t.Object({
  secret: $t.Optional($t.String()),
  issuer: $t.Optional($t.String()),
  audience: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
  algorithm: $t.Optional($t.String()),
  expiresIn: $t.Optional(ttl()),
  roleClaimType: $t.Optional($t.String()),
  includeErrorDetails: $t.Optional($t.Boolean()),
})

type _JWTSatisfies = SchemaSatisfies<JWTSchemeConfig, InferConfig<typeof JWTSchemeConfigSchema>>

/** A basic scheme's block. */
export const BasicSchemeConfigSchema = $t.Object({ realm: $t.Optional($t.String()) })

type _BasicSatisfies = SchemaSatisfies<BasicSchemeConfig, InferConfig<typeof BasicSchemeConfigSchema>>

/** An opaque-token scheme's block. */
export const OpaqueSchemeConfigSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  realm: $t.Optional($t.String()),
})

type _OpaqueSatisfies = SchemaSatisfies<OpaqueSchemeConfig, InferConfig<typeof OpaqueSchemeConfigSchema>>

/** A cookie scheme's block. */
export const CookieSchemeConfigSchema = $t.Object({
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

type _CookieSchemeSatisfies = SchemaSatisfies<CookieSchemeConfig, InferConfig<typeof CookieSchemeConfigSchema>>

/** An OpenID Connect scheme's block. */
export const OIDCSchemeConfigSchema = $t.Object({
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

type _OIDCSatisfies = SchemaSatisfies<OIDCSchemeConfig, InferConfig<typeof OIDCSchemeConfigSchema>>

/** An OAuth 2.0 scheme's block, GitHub's included. */
export const OAuthSchemeConfigSchema = $t.Object({
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

type _OAuthSatisfies = SchemaSatisfies<OAuthSchemeConfig, InferConfig<typeof OAuthSchemeConfigSchema>>

/** `credentials.*`: the identity stamped on a principal built from a username and password. */
const credentialsConfigSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  roleClaimType: $t.Optional($t.String()),
})

type _CredentialsSatisfies = SchemaSatisfies<AuthCredentialsConfig, InferConfig<typeof credentialsConfigSchema>>

/** `refresh.*`: the three token lifetimes. */
const refreshConfigSchema = $t.Object({
  accessTtl: $t.Optional(ttl()),
  refreshTtl: $t.Optional(ttl()),
  absoluteTtl: $t.Optional(ttl()),
})

type _RefreshSatisfies = SchemaSatisfies<RefreshTokenConfig, InferConfig<typeof refreshConfigSchema>>

/**
 * The schema of the authentication configuration block, satisfying {@link AuthConfig}. Hand the node to
 * `Authentication((a, { config }) => a.config(...))`.
 *
 * A scheme's kind is known only to its `addX(...)` call, so each entry under `schemes` accepts every kind's keys
 * and the scheme reads its own. A key no kind declares is dropped when the configuration loads. Declaring the
 * schemes precisely checks each one against its kind instead:
 *
 * ```ts
 * $t.Object({ ...AuthConfigSchema.properties, schemes: $t.Object({ jwt: JWTSchemeConfigSchema }) })
 * ```
 */
export const AuthConfigSchema = $t.Object({
  defaultAuthenticateScheme: $t.Optional($t.String()),
  defaultChallengeScheme: $t.Optional($t.String()),
  defaultForbidScheme: $t.Optional($t.String()),
  schemes: $t.Optional(
    $t.Record(
      $t.String(),
      // OpenID Connect last: its `tokenEndpointAuthMethod` also takes `'auto'`.
      $t.Object({
        ...JWTSchemeConfigSchema.properties,
        ...BasicSchemeConfigSchema.properties,
        ...OpaqueSchemeConfigSchema.properties,
        ...CookieSchemeConfigSchema.properties,
        ...OAuthSchemeConfigSchema.properties,
        ...OIDCSchemeConfigSchema.properties,
      }),
    ),
  ),
  credentials: $t.Optional(credentialsConfigSchema),
  refresh: $t.Optional(refreshConfigSchema),
})

type _AuthSatisfies = SchemaSatisfies<AuthConfig, InferConfig<typeof AuthConfigSchema>>
