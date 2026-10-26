import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { DevToolsConfig } from '../devtools.js'

/**
 * The schema of the devtools configuration block, satisfying {@link DevToolsConfig}. Hand the node to
 * `DevTools((d, { config }) => d.config(...))`.
 *
 * Where the devtools listen is configuration; whether they start in production, show values or what they require is
 * code alone, so no variable in an environment opens them.
 */
export const DevToolsConfigSchema = $t.Object({
  host: $t.Optional($t.String({ minLength: 1 })),
  port: $t.Optional($t.Integer({ minimum: 0, maximum: 65_535 })),
  path: $t.Optional($t.String({ minLength: 2 })),
})

type _Satisfies = SchemaSatisfies<DevToolsConfig, InferConfig<typeof DevToolsConfigSchema>>
