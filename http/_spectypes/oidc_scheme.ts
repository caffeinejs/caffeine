import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { OIDCSchemeConfig } from '../core/security/auth/config.js'

const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

/** An OpenID Connect scheme's block. */
export const OIDCSchemeConfigSchema = $t.Object({
  clientId: $t.Optional($t.String()),
  clientSecret: $t.Optional($t.String()),
  sessionSecret: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
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
  sessionCookieTtl: $t.Optional($t.Duration()),
  stateCookieName: $t.Optional($t.String()),
  secureCookie: $t.Optional($t.Boolean()),
  cookieDomain: $t.Optional($t.String()),
  cookiePartitioned: $t.Optional($t.Boolean()),
  cookiePriority: $t.Optional($t.UnionEnum(['low', 'medium', 'high'])),
  roleClaimType: $t.Optional($t.String()),
  allowPlainPkce: $t.Optional($t.Boolean()),
  clockTolerance: $t.Optional($t.Duration()),
  httpTimeout: $t.Optional($t.Duration()),
  discoveryCacheTtl: $t.Optional($t.Duration()),
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
  maxAge: $t.Optional($t.Duration()),
  extraAuthorizationParams: $t.Optional($t.Record($t.String(), $t.String())),
})

type _Satisfies = SchemaSatisfies<OIDCSchemeConfig, InferConfig<typeof OIDCSchemeConfigSchema>>
