import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { HTMLDefaults } from '../config.js'

/**
 * The schema of the HTML configuration block, satisfying {@link HTMLDefaults}. Hand the node to the plugin:
 * `.with(html(({ config }) => ...))`.
 */
export const HTMLConfigSchema = $t.Object({
  autoDoctype: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<HTMLDefaults, InferConfig<typeof HTMLConfigSchema>>
