import { $t } from '../schema/t.js'

/**
 * The logger slice of the configuration tree.
 *
 * `use()` is not here: it takes a logger instance, and an instance cannot travel a configuration tree.
 */
export interface LoggerConfig {
  level?: string
  enabled?: boolean
}

/**
 * The schema governing the logger slice.
 *
 * Both members are optional and neither is defaulted: absence has to keep meaning "nobody set this", or a
 * fluent call could not win over what the tree carries.
 *
 * `enabled` is stated positively, like every other feature's slice, while the fluent method is
 * {@link LoggerBuilder.disable} — `enabled: false` is what disables the logger.
 */
export const loggerConfigSchema = $t.Object({
  level: $t.Optional($t.String()),
  enabled: $t.Optional($t.Boolean()),
})
