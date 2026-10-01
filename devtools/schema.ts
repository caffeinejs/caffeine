import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { DevtoolsOptions } from './server/server.js'

/**
 * The schema of the devtools configuration block, satisfying {@link DevtoolsOptions}. Hand the node to
 * `DevtoolsModule(...)`.
 */
export const DevtoolsConfigSchema = $t.Object({
  port: $t.Optional($t.Integer({ minimum: 0, maximum: 65_535 })),
})

type _Satisfies = SchemaSatisfies<DevtoolsOptions, InferConfig<typeof DevtoolsConfigSchema>>
