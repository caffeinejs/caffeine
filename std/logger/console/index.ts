import type { Logger } from '../logger.js'
import { ConsoleLogger, type ConsoleLoggerOptions } from './console.js'

export * from './console.js'

/**
 * A {@link Logger} that writes through `console`.
 *
 * ```ts
 * newConsoleLogger({ level: 'debug' })
 * ```
 */
export function newConsoleLogger(options?: ConsoleLoggerOptions): Logger {
  return new ConsoleLogger(options)
}
