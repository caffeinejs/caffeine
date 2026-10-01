import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { BasicSchemeConfig } from '../security/auth/config.js'

/** A basic scheme's block. */
export const BasicSchemeConfigSchema = $t.Object({ realm: $t.Optional($t.String()) })

type _Satisfies = SchemaSatisfies<BasicSchemeConfig, InferConfig<typeof BasicSchemeConfigSchema>>
