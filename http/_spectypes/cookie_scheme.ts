import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { CookieSchemeConfig } from '../security/auth/config.js'

const challengeMode = (): ReturnType<typeof $t.UnionEnum> => $t.UnionEnum(['auto', 'redirect', 'status'])

/** A cookie scheme's block. */
export const CookieSchemeConfigSchema = $t.Object({
  sessionSecret: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
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
  domain: $t.Optional($t.String()),
  partitioned: $t.Optional($t.Boolean()),
  priority: $t.Optional($t.UnionEnum(['low', 'medium', 'high'])),
  roleClaimType: $t.Optional($t.String()),
})

type _Satisfies = SchemaSatisfies<CookieSchemeConfig, InferConfig<typeof CookieSchemeConfigSchema>>
