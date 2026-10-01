import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { HTMLDefaults } from '../config.js'

/**
 * The schema of the HTML configuration block, satisfying {@link HTMLDefaults}. Hand the node to the plugin:
 * `.with(({ config }) => html(...))`.
 */
export const HTMLConfigSchema = $t.Object({
  autoDoctype: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<HTMLDefaults, InferConfig<typeof HTMLConfigSchema>>
