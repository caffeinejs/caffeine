import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { CSRFConfig } from '../core/csrf/options.js'

/** The `csrf()` plugin's block. */
export const CSRFConfigSchema = $t.Object({
  enabled: $t.Optional($t.Boolean()),
  trustedOrigins: $t.Optional($t.Array($t.String())),
  exclude: $t.Optional($t.Array($t.String())),
})

type _Satisfies = SchemaSatisfies<CSRFConfig, InferConfig<typeof CSRFConfigSchema>>
