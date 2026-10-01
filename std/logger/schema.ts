import type { InferConfig, SchemaSatisfies } from '../config/types.js'
import { $t } from '../schema/t.js'
import type { LoggerConfig } from './config.js'

/**
 * The schema of the logger's configuration block, satisfying {@link LoggerConfig}.
 *
 * Both members are optional and neither is defaulted: absence has to keep meaning "nobody set this", or a
 * fluent call could not win over what the tree carries.
 *
 * `enabled` is stated positively, like every other feature's block, while the fluent method is `disable()`:
 * `enabled: false` is what disables the logger.
 */
export const LoggerConfigSchema = $t.Object({
  level: $t.Optional($t.String()),
  enabled: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<LoggerConfig, InferConfig<typeof LoggerConfigSchema>>
