import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { OIDCSchemeConfig } from '../security/auth/config.js'

const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

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

type _Satisfies = SchemaSatisfies<OIDCSchemeConfig, InferConfig<typeof OIDCSchemeConfigSchema>>
