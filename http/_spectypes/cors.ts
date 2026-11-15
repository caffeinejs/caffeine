import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { CORSConfig } from '../core/cors/cors.js'

/** The `corsPolicy()` plugin's block. */
export const CORSConfigSchema = $t.Object({
  origins: $t.Optional($t.Array($t.String())),
  credentials: $t.Optional($t.Boolean()),
  allowedHeaders: $t.Optional($t.Array($t.String())),
  exposedHeaders: $t.Optional($t.Array($t.String())),
  maxAge: $t.Optional($t.Duration()),
})

type _Satisfies = SchemaSatisfies<CORSConfig, InferConfig<typeof CORSConfigSchema>>
