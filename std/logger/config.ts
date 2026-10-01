/**
 * The logger slice of the configuration tree.
 *
 * `use()` is not here: it takes a logger instance, and an instance cannot travel a configuration tree.
 */
export interface LoggerConfig {
  level?: string
  enabled?: boolean
}
