import type { Logger as PinoInstance, LoggerOptions } from 'pino'

import type { Logger } from '../logger.js'
import { PinoLogger } from './pino.js'

export * from './pino.js'

/**
 * A {@link Logger} backed by Pino.
 *
 * ```ts
 * newPinoLogger({ level: 'debug' })
 * newPinoLogger(pino({ level: 'debug' }, pino.destination('./app.log')))
 * ```
 */
export function newPinoLogger(options?: LoggerOptions | PinoInstance): Logger {
  return new PinoLogger(options)
}
