import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { CSRFConfig } from '../csrf/options.js'

/** The `csrf()` plugin's block. */
export const CSRFConfigSchema = $t.Object({
  enabled: $t.Optional($t.Boolean()),
  trustedOrigins: $t.Optional($t.Array($t.String())),
  exclude: $t.Optional($t.Array($t.String())),
})

type _Satisfies = SchemaSatisfies<CSRFConfig, InferConfig<typeof CSRFConfigSchema>>
