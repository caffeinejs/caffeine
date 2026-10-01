import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { OAuthSchemeConfig } from '../security/auth/config.js'

const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

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

type _Satisfies = SchemaSatisfies<OAuthSchemeConfig, InferConfig<typeof OAuthSchemeConfigSchema>>
