import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { JWTSchemeConfig } from '../security/auth/config.js'

const ttl = (): ReturnType<typeof $t.Union> => $t.Union([$t.String(), $t.Number()])

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

type _Satisfies = SchemaSatisfies<JWTSchemeConfig, InferConfig<typeof JWTSchemeConfigSchema>>
