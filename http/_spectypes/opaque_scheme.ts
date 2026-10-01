import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { OpaqueSchemeConfig } from '../security/auth/config.js'

/** An opaque-token scheme's block. */
export const OpaqueSchemeConfigSchema = $t.Object({
  scheme: $t.Optional($t.String()),
  realm: $t.Optional($t.String()),
})

type _Satisfies = SchemaSatisfies<OpaqueSchemeConfig, InferConfig<typeof OpaqueSchemeConfigSchema>>
