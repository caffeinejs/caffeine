import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { DevToolsConfig } from '../options.js'

/**
 * The schema of a DevTools configuration block, satisfying {@link DevToolsConfig}. Hand its node to
 * `devTools(d => d.config(...))`.
 */
export const DevToolsConfigSchema = $t.Object({
  path: $t.Optional($t.String()),
})

type _Satisfies = SchemaSatisfies<DevToolsConfig, InferConfig<typeof DevToolsConfigSchema>>
