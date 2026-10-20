import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { JWTSchemeConfig } from '../core/security/auth/config.js'

/** A JWT bearer scheme's block. Only the string form of `secret` is configurable. */
export const JWTSchemeConfigSchema = $t.Object({
  secret: $t.Optional($t.String()),
  issuer: $t.Optional($t.String()),
  audience: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
  algorithm: $t.Optional($t.String()),
  expiresIn: $t.Optional($t.Duration()),
  roleClaimType: $t.Optional($t.String()),
  includeErrorDetails: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<JWTSchemeConfig, InferConfig<typeof JWTSchemeConfigSchema>>
