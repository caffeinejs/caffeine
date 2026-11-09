import type { Logger } from '@caffeinejs/application/logger'
import { PinoLogger } from '@caffeinejs/application/logger/pino'

/**
 * The application logger, handed to `createWebApplication` as `ApplicationOptions.logger`: the only path that reaches
 * the Fastify server, which reads its logger while it constructs. The `.logger(...)` feature callback then sets the
 * level from configuration.
 */
export function createLogger(): Logger {
  return new PinoLogger({ level: 'info', base: undefined })
}
